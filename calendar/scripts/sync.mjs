// Keeps a Google Calendar in sync with the YAML files in /calendar.
//
//   node sync.mjs --validate  only validate all the files (no credentials needed)
//   BASE_SHA=<git-ref> node sync.mjs  sync the files added/changed/removed since <git-ref>
//
// Every file maps to exactly one event with a deterministic ID, so syncing is idempotent.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'
import yaml from 'js-yaml'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')
const calendarDir = join(repoRoot, 'calendar')
const FIELDS = ['startTime', 'endTime', 'timeZone', 'title', 'location', 'description', 'link']

function listEventFiles() {
  const files = []
  if (!existsSync(calendarDir)) return files
  for (const year of readdirSync(calendarDir, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
    for (const f of readdirSync(join(calendarDir, year.name), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.yaml')) files.push(join(calendarDir, year.name, f.name))
      else if (f.isFile() && f.name.endsWith('.yml')) files.push(join(calendarDir, year.name, f.name))
    }
  }
  return files.sort()
}

// calendar/<YYYY>/<MM>-<DD>[-<slug>].yaml. Several events can share a day if their slugs differ.
const PATH_RE = /^calendar\/(\d{4})\/(\d{2})-(\d{2})(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\.yaml$/

function parsePath(path) {
  const m = PATH_RE.exec(path)
  if (!m) return { error: 'path must look like calendar/<YYYY>/<MM>-<DD>.yaml or calendar/<YYYY>/<MM>-<DD>-<slug>.yaml (slug: lowercase letters, digits and dashes)' }
  const [, y, mo, d, slug = ''] = m
  const dt = new Date(Date.UTC(+y, +mo - 1, +d))
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) {
    return { error: `${y}-${mo}-${d} is not a valid date` }
  }
  return { date: `${y}-${mo}-${d}`, slug }
}

function parseEvent(file) {
  const path = relative(repoRoot, file)
  const errors = []
  const { date, slug, error } = parsePath(path)
  if (error) errors.push(error)

  let data
  try {
    data = yaml.load(readFileSync(file, 'utf8'))
  } catch (e) {
    return { path, errors: [...errors, `invalid YAML: ${e.message}`] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { path, errors: [...errors, 'file must contain a YAML mapping'] }
  }

  for (const k of Object.keys(data)) {
    if (!FIELDS.includes(k)) errors.push(`unknown property "${k}"`)
  }
  for (const k of FIELDS) {
    if (typeof data[k] !== 'string' || data[k].trim() === '') {
      errors.push(`"${k}" is required and must be a non-empty string (quote times, e.g. "14:00")`)
    }
  }
  if (errors.length) return { path, errors }

  const time = /^([01]\d|2[0-3]):[0-5]\d$/
  for (const k of ['startTime', 'endTime']) {
    if (!time.test(data[k])) errors.push(`"${k}" must be HH:MM in 24h format, got "${data[k]}"`)
  }
  if (time.test(data.startTime) && time.test(data.endTime) && data.endTime <= data.startTime) {
    errors.push('"endTime" must be after "startTime" (events cannot span midnight)')
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: data.timeZone })
  } catch {
    errors.push(`"timeZone" must be an IANA time zone such as "Europe/Paris", got "${data.timeZone}"`)
  }
  try {
    const u = new URL(data.link)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error()
  } catch {
    errors.push(`"link" must be an http(s) URL, got "${data.link}"`)
  }
  if (errors.length) return { path, errors }

  return { path, errors, date, slug, ...data }
}

// Google event IDs: 5-1024 chars of a-v and 0-9. A hex digest fits.
// The ID depends on the date and slug only.
const eventId = (date, slug) => 'gql' + createHash('sha1').update(`${date}/${slug}`).digest('hex')

function toGoogleEvent(e) {
  return {
    id: eventId(e.date, e.slug),
    summary: e.title.trim(),
    location: e.location.trim(),
    description: `${e.description.trim()}\n\n${e.link}`,
    source: { title: 'GraphQL Working Sessions', url: e.link },
    start: { dateTime: `${e.date}T${e.startTime}:00`, timeZone: e.timeZone },
    end: { dateTime: `${e.date}T${e.endTime}:00`, timeZone: e.timeZone },
  }
}

function getCalendar() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!calendarId || !key) {
    throw new Error('GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_KEY must be set')
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(key),
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
  })
  return { calendarId, cal: google.calendar({ version: 'v3', auth }) }
}

// Creates the event or, if its ID already exists (even as a cancelled event), updates it.
async function upsert({ cal, calendarId }, body) {
  try {
    await cal.events.insert({ calendarId, requestBody: body })
    return 'created'
  } catch (err) {
    if (err.code !== 409) throw err
    await cal.events.update({ calendarId, eventId: body.id, requestBody: { ...body, status: 'confirmed' } })
    return 'updated'
  }
}

async function remove({ cal, calendarId }, id) {
  try {
    await cal.events.delete({ calendarId, eventId: id })
    return true
  } catch (err) {
    if (err.code === 404 || err.code === 410) return false // already gone
    throw err
  }
}

// Only touches the files that changed between `base` and HEAD.
async function syncIncremental(base) {
  const diff = execFileSync(
    'git',
    ['diff', '--name-status', '--no-renames', '-z', base, 'HEAD', '--', 'calendar'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  // -z output: STATUS \0 path \0 STATUS \0 path ...
  const parts = diff.split('\0').filter(Boolean)
  const changes = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (/^calendar\/\d{4}\/.*\.ya?ml$/.test(parts[i + 1])) changes.push({ status: parts[i], path: parts[i + 1] })
  }
  if (!changes.length) return console.log('No event file changed, nothing to sync')

  const toUpsert = changes.filter((c) => c.status !== 'D').map((c) => parseEvent(join(repoRoot, c.path)))
  failOnInvalid(toUpsert)

  const client = getCalendar()
  for (const c of changes.filter((c) => c.status === 'D')) {
    const { date, slug } = parsePath(c.path)
    if (!date) continue
    const gone = await remove(client, eventId(date, slug))
    console.log(`${c.path}: ${gone ? 'deleted' : 'was not in the calendar'}`)
  }
  for (const e of toUpsert) console.log(`${e.path}: ${await upsert(client, toGoogleEvent(e))}`)
}

function failOnInvalid(events) {
  const invalid = events.filter((e) => e.errors.length)
  for (const e of invalid) {
    for (const msg of e.errors) console.error(`::error file=${e.path}::${msg}`)
  }
  if (invalid.length) {
    console.error(`${invalid.length} invalid event file(s)`)
    process.exit(1)
  }
}

if (process.argv.includes('--validate')) {
  const events = listEventFiles().map(parseEvent)
  failOnInvalid(events)
  console.log(`${events.length} event file(s) valid`)
} else if (process.env.BASE_SHA) {
  await syncIncremental(process.env.BASE_SHA)
} else {
  console.error('usage: sync.mjs --validate, or set BASE_SHA to the git ref to sync from')
  process.exit(2)
}
