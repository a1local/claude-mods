# publish-schedule

`/publishing` answers in the chat with what you are due to publish today and tomorrow: long films and Shorts, across one or more channels and platforms. It reads one JSON file you keep (or generate), so it works with any channel and any posting rhythm.

```
Publishing
Today, Sat 28 Nov
1.  00:05  Demo Channel   Film   How Deep Is the Ocean?    YT FB  done
2.  09:05  Demo Channel   Short  Squid Have Three Hearts   TT     overdue 25 min
3.  10:00  Other Channel  Short  The Moon Is Moving Away   YT     in 30 min
4.  14:05  Demo Channel   Short  Octopus Arms Can Taste    YT FB  later
Tomorrow, Sun 29 Nov
5.  00:05  Demo Channel   Film   Why Whales Sing           YT     scheduled
2 due today · 1 overdue · updated 09:30
```

In the chat it is drawn as a rounded box in the claude-mods look: the title in bold, the day lines dim, one line per item with the columns lined up, and the counts in a dim footnote. Each item shows:

- **Number**, for `/publishing done <n>`.
- **Time**, in your computer's time zone (24-hour).
- **Channel**, bold, in the entry's `color` if it has one, else a steady colour picked from the name.
- **Kind**: Film or Short.
- **Title**, cut to 40 characters.
- **Platforms**, dim and shortened: YT (YouTube), FB (Facebook), TT (TikTok), IG (Instagram); any other name as written.
- **Status**: `done` in green; `in 25 min` in amber when due within the hour; `overdue 25 min` in red when its time has passed and it is not done; `scheduled` in blue for a scheduled upload still to come; `later` dim otherwise.

Items from earlier days that are still not done stay at the top under "Earlier, not done" for a week. The footnote counts what is still due today, what is overdue, and when the file was last read.

(`/schedule` is taken by a command Claude Code ships, hence `/publishing`.)

### Marking an item done

```
/publishing done 2
```

writes `"done": true` for row 2 of the last reply into the schedule file and answers the refreshed reply, with `marked 2 done` in the footnote. The numbers are the ones the last `/publishing` reply showed.

### Above the prompt

When something is due within the hour, or overdue, it shows above the prompt on one line, the most urgent first. With several, **‹ 2/3 ›** flicks between them:

```
overdue 25 min  09:05  Demo Channel  Short  Squid Have Three Hearts   ‹ 1/2 ›  ✕
```

**✕** closes the one in view for the session; `/publishing` brings closed ones back and starts again from the first. With nothing due within the hour and nothing overdue, nothing is drawn.

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
    "done": false,
    "color": "suggestion"
  }
]
```

| Field | Meaning |
| --- | --- |
| `at` | Local time, `YYYY-MM-DDTHH:MM` (seconds allowed), with no time zone. Read in the computer's time zone. |
| `channel` | Channel name. Rows of the same channel share a colour. |
| `kind` | `film` or `short`. |
| `title` | What the row is called. |
| `done` | Optional. `true` once published; `/publishing done <n>` sets it. |
| `scheduled` | Optional. `true` when the platform will publish it by itself (a scheduled upload). It then counts as done once its time has passed, instead of turning overdue. |
| `platforms` | Optional. Where it goes, such as `["youtube", "facebook", "tiktok"]`. |
| `color` | Optional. The channel's colour, a theme key such as `suggestion`, `claude`, `success` or `merged`. Left out, the channel name picks a steady one. |

Entries without a valid `at` or `title` are skipped. `/publishing done <n>` changes only the `done` field of the entry it names (found by its `at`, `channel` and `title`) and keeps the rest of the file as it is, rewritten with 2-space indents.

A script can build the file from your own publishing records; run it again whenever they change, and carry over `done: true` from the old file so items marked done stay done.

## Settings

In the config menu, or under `pluginConfigs` in settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `scheduleFile` | `~/.claude-mods/schedule.json` (when left empty) | The schedule file. `~` means your home folder. |
| `band` | `on` | `off` hides the lines above the prompt; `/publishing` still works. |

## License

MIT
