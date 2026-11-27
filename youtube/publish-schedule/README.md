# publish-schedule

A **Publishing** pane in Claude Code that lists what you are due to publish today and tomorrow: long films and Shorts, across one or more channels and platforms. It reads one JSON file you keep (or generate), so it works with any channel and any posting rhythm.

```
Today, Sat 28 Nov
00:05 Demo Channel  Film  How Deep Is the Ocean?           YT FB  done
09:05 Demo Channel  Short Squid Have Three Hearts          TT     overdue 25 min  [Done]
10:00 Other Channel Short The Moon Is Moving Away          YT     in 30 min       [Done]
14:05 Demo Channel  Short Octopus Arms Can Taste           YT FB  later           [Done]

Tomorrow, Sun 29 Nov
00:05 Demo Channel  Film  Why Whales Sing                  YT     later           [Done]
```

Each row shows:

- **Time**, in your computer's time zone.
- **Channel**, coloured so channels are easy to tell apart.
- **Kind**: Film or Short.
- **Title**.
- **Platforms**, shortened: YT (YouTube), FB (Facebook), TT (TikTok), IG (Instagram); any other name as written.
- **Status**: `done` in green; `in 25 min` when due within the hour; `overdue 25 min` in red when its time has passed and it is not done; `later` otherwise.
- A **Done** button, which writes `"done": true` for that item back into the file.

Items from earlier days that are still not done stay at the top under "Earlier, not done" for a week.

Open the pane with `/publishing`. (`/schedule` is taken by a command Claude Code ships.)

When something is due within the hour, or overdue, a one-line reminder shows above the prompt:

```
Next: Short 10:00 Other Channel "The Moon Is Moving Away" (in 30 min)
```

An overdue item comes first, in red, with a count of the rest: `Overdue: Short 09:05 Demo Channel "Squid Have Three Hearts" (25 min ago) +1 more`. With nothing due within the hour and nothing overdue, nothing is drawn.

The file is read again every minute, so edits by hand or by a script show up without a reload.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install publish-schedule --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install publish-schedule --marketplace a1local/claude-mods
```

## The schedule file

Default `~/.claude-mods/schedule.json`: a JSON list (or an object with the list under `"items"`). For example:

```json
[
  {
    "at": "2026-11-28T00:05",
    "channel": "Demo Channel",
    "kind": "film",
    "title": "How Deep Is the Ocean?",
    "platforms": ["youtube", "facebook"],
    "scheduled": true
  },
  {
    "at": "2026-11-28T09:05",
    "channel": "Demo Channel",
    "kind": "short",
    "title": "Squid Have Three Hearts",
    "platforms": ["tiktok"],
    "done": false
  }
]
```

| Field | Meaning |
| --- | --- |
| `at` | Local time, `YYYY-MM-DDTHH:MM` (seconds allowed), with no time zone. Read in the computer's time zone. |
| `channel` | Channel name. Rows of the same channel share a colour. |
| `kind` | `film` or `short`. |
| `title` | What the row is called. |
| `done` | Optional. `true` once published; the Done button sets it. |
| `scheduled` | Optional. `true` when the platform will publish it by itself (a scheduled upload). It then counts as done once its time has passed, instead of turning overdue. |
| `platforms` | Optional. Where it goes, such as `["youtube", "facebook", "tiktok"]`. |

Entries without a valid `at` or `title` are skipped. The Done button changes only the `done` field of the entry it belongs to (found by its `at`, `channel` and `title`) and keeps the rest of the file as it is, rewritten with 2-space indents.

A script can build the file from your own publishing records; run it again whenever they change, and carry over `done: true` from the old file so Done presses are kept.

## Settings

In the config menu, or under `pluginConfigs` in settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `scheduleFile` | `~/.claude-mods/schedule.json` (when left empty) | The schedule file. `~` means your home folder. |
| `band` | `on` | `off` hides the reminder above the prompt; the pane still works. |

## License

MIT
