# Working sessions calendar

This folder holds data to modify the calendar at https://calendar.graphql.org

Every event of the working sessions calendar lives in this folder as a small YAML file.
When a change to this folder is merged to `main`, a GitHub Action updates the shared Google Calendar automatically. **Never edit the Google Calendar by hand**: manual changes to synced events are overwritten on the next sync.

## One file per event

```
calendar/<year>/<month>-<day>-<slug>.yaml
```

For example `calendar/2026/11-04-working-session.yaml` is an event on 4 November 2026. Month and day are always two digits. The date of the event comes from the file name.

The optional slug (lowercase letters, digits and dashes) lets you have **several events on the same day**: `11-04-working-session.yaml` and `11-04-social.yaml` are two separate events. A day can have at most one event without a slug (`11-04.yaml`), and each slug can be used once per day.

The slug is not shown in the calendar, but it identifies the event: **renaming a file to change its slug removes the old calendar event and creates a new one**.

## File format

```yaml
startTime: "16:00"
endTime: "17:00"
timeZone: Europe/Paris
title: GraphQL Working Session
location: https://zoom.us/j/0000000000
description: Agenda and notes for this session.
link: https://github.com/graphql/working-sessions
```

| Property      | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `startTime`   | Start time, 24h `HH:MM`, in `timeZone`. **Put it in quotes.**            |
| `endTime`     | End time, 24h `HH:MM`, in `timeZone`. Must be after `startTime`.         |
| `timeZone`    | [IANA time zone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `America/New_York`, `Europe/Paris`, `UTC`. |
| `title`       | Event title.                                                             |
| `location`    | Free text: a video call URL, an address, etc.                            |
| `description` | Free text description.                                                   |
| `link`        | `http(s)` URL with more information (agenda, notes, ...). It is also appended to the calendar event description. |

All properties are required and no other property is allowed.

## Adding an event

1. Create `calendar/<year>/<month>-<day>[-<slug>].yaml` with the properties above.
2. Open a pull request. A check validates your file and reports errors on the offending files.
3. Once the PR is merged, the event shows up in the Google Calendar within a minute or so.

## Editing an event

Edit the file and open a pull request. The existing calendar event is updated in place.

To **move an event to another day** (or change its slug), rename the file. The old event is removed and a new one is created.

## Removing an event

Delete the file in a pull request. The event is removed from the Google Calendar on merge.

## Validation

You can check your changes locally (Node 20+):

```sh
cd calendar/scripts && npm ci && cd -
node calendar/scripts/sync.mjs --validate
```

## Maintainers: setup

The sync workflow (`.github/workflows/calendar-sync.yml`) needs two repository secrets:

- `GOOGLE_SERVICE_ACCOUNT_KEY`: the JSON key of a Google Cloud service account (with the Google Calendar API enabled).
- `GOOGLE_CALENDAR_ID`: the ID of the target calendar (Calendar settings → "Integrate calendar").

Share the target calendar with the service account's email address with the **"Make changes to events"** permission.

The workflow is incremental: on each push to `main` it only creates, updates or deletes the events of the files that changed in that push. Events not backed by a file in this folder are never touched.
