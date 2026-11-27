# render-progress

A progress bar above the prompt in Claude Code (the desktop app and the terminal) for renders that take minutes or hours. One line per render:

```
The Longest Night On Mars  [###########54%########--------] ETA:21:58 7.4k/13.5k 2/10c
```

- **Title**, coloured by channel, so different projects are easy to tell apart.
- **Bar** with the percent inside it. While a render is bundling or uploading, the stage is written there instead.
- **Finish time** in your time zone (`ETA:21:58`). When a render is over, `done 3:31:00` in green or `FAILED` in red.
- **Frames** done out of the total.
- **Cores**: CPU cores the render's processes are using now, out of the computer's total.

It shows every render on the computer, whichever session or terminal started it. With nothing rendering, nothing is drawn. A finished render stays for 2 hours. Every row has a **✕** that closes it; `/renders` brings closed rows back and lists what's rendering. A render whose logs stop for 15 minutes turns red as `stalled`.

When a render finishes, fails or stalls, it raises a toast in Claude Code and a native notification once per change. The notification goes through your Claude Code notification setting, so it can reach your phone. Turn this off with the mod's **Alerts** setting.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install render-progress --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install render-progress --marketplace a1local/claude-mods
```

## How renders show up

Each render describes itself in one small file of `key=value` lines in `~/.render-progress/` (change the folder with the mod's **Registry folder** setting). Name the file anything without a dot, such as `<project>-<pid>`. The mod reads the folder every 3 seconds. Lines every kind uses:

| Line | Meaning |
| --- | --- |
| `kind=` | `remotion`, `lambda` or `command` (below) |
| `title=` | What the row is called |
| `channel=` | Optional. Rows of the same channel share a colour |
| `color=` | Optional. The title's colour: a theme key (`success`, `suggestion`, `claude`, `warning`, ...), a colour name or hex |
| `pid=` | Optional. The render's process ID, for the cores column; its child processes are counted too |
| `start=` | Unix time the render started, in seconds |

### `kind=remotion`: a `remotion render` work folder

| Line | Meaning |
| --- | --- |
| `work=` | Folder holding `status` and one `partN.log` per `remotion render` (logged without `--log=error`, so it prints `Rendered N/M`) |
| `frames=` | Frames in the whole film |

`status` lines the mod reads: `partN ok`, `audio ok`, `DONE <file>`, and anything with `FAILED`. A render script can write the file like this once it knows the frame count:

```bash
mkdir -p ~/.render-progress
printf 'kind=remotion\ntitle=%s\nchannel=%s\nwork=%s\nframes=%s\nstart=%s\npid=%s\n' \
  "$TITLE" "$CHANNEL" "$WORK" "$FRAMES" "$(date +%s)" "$$" > ~/.render-progress/"$NAME-$$"
```

### `kind=lambda`: a Remotion Lambda render

`work=` is a folder with `status` (`site <url>`, `video ok`, `DONE <file>`, `FAILED`) and the CLI's `lambda.log`. It shows the stage (bundling, uploading, rendering, joining), not a frame count.

### `kind=command`: anything else, such as Blender

| Line | Meaning |
| --- | --- |
| `cmd=` | A command (run with `sh -c`) that prints one line of JSON: `{"total": n, "done": n, "running": true, "started": unixSeconds, "finished": unixSeconds, "pids": [n]}`. `started`, `finished` and `pids` are optional |
| `cwd=` | Folder to run it in |

It runs at most every 15 seconds. The row shows while `running` is true, and the finish time comes from how fast `done` rose over the last 10 minutes. Once `done` reaches `total` the row turns green as `done` (with an alert) and leaves 2 hours after `finished`, or after it was first seen complete if the command gives no `finished`. A Blender example that counts saved frames:

```
kind=command
title=My Blender Film
cwd=/path/to/project
cmd=echo "{\"total\": 14400, \"done\": $(ls render/frames | wc -l), \"running\": $(pgrep -f 'blender -b' >/dev/null && echo true || echo false)}"
```

## Developing

`claude plugin test render-progress` runs the tests, and `claude plugin validate render-progress` checks the mod. Claude Code's function hooks are in early access, so the API may change between releases.

## License

MIT. See [LICENSE](LICENSE).
