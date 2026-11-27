# machine-monitor

Keeps an eye on a Mac that runs long renders and several Claude Code sessions at once. It does four things.

**1. A status line under the prompt**, refreshed every 5 seconds:

```
load 6.2/10 · GPU 100% · swap 4.8/6.0G · disk 41G free
```

- **load**: the 1-minute load average, out of the number of CPU cores.
- **GPU**: how busy the GPU is.
- **swap**: swap in use out of the swap file's current size.
- **disk**: free space on the watched path with the least room.
- **temp**: the total size of the temp folders, added only while it is over the warning.

Anything that can't be read is left out of the line.

**2. A `/machine` command.** Type `/machine` for every measure against its limit, drawn in the chat as a box:

```
Machine
load    [######----]   62%  6.2 of 10 cores
GPU     [##########]  100%
swap    [########--]   80%  4.8 of 6.0 GB
disk ~  [#########-]   91%  41 GB free of 460 GB
temp    [######----]   60%  12.0 of 20 GB
limit 20 · heavy jobs held back above it · updated 21:45
```

- **load**: the 1-minute load out of the CPU cores. Its colour compares the load with the load limit.
- **GPU**: how busy the GPU is.
- **swap**: swap in use out of the swap file's size.
- **disk**: one row per watched path; the bar is the share of the disk in use. Its colour compares the free space with the low-disk warning.
- **temp**: the temp folders' size against the temp warning, once they have been measured.

Green is under 70% of the limit, amber from there, red over it. The footnote gives the load limit and when the numbers were measured. Numbers older than 10 seconds are measured again first.

**3. A load guard.** When Claude is about to run a Bash command that starts a heavy job (a Remotion render, Blender in the background, ffmpeg, and so on) while the 1-minute load is over the limit, the command is refused and Claude is told:

```
Machine load is 34 (limit 20). Wait a few minutes and retry; check with uptime.
```

Commands that are not heavy always run. If the load can't be read, or the guard itself fails, the command runs: a broken guard should not block every render.

A pattern matches as whole words anywhere in the command, in any case, so `ffmpeg` matches `ffmpeg -i a.mov b.mp4` and also `which ffmpeg`, but not `ffprobe`.

**4. Disk warnings.** A toast in Claude Code and a system notification, worded like `Disk: only 10 GB free on ~` or `Temp folders: 30 GB (limit 20 GB)`, when:

- a watched path has less free space than the warning, or
- the temp folders add up to more than the warning.

Each warns once when it crosses the line, not on every check. It can warn again after the value has come back at least 1 GB past the line. Temp folder sizes are measured with `du` at most every 2 minutes, since that is slow on big folders. Each running Claude Code session runs its own copy of the mod, so with three sessions open you may get three notifications.

macOS only: it reads `sysctl`, `getconf`, `df`, `du` and `ioreg`.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install machine-monitor --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install machine-monitor --marketplace a1local/claude-mods
```

## Settings

Set these in the mod's settings (the `/plugin` menu, or `pluginConfigs` in settings):

| Setting | Default | Meaning |
| --- | --- | --- |
| `loadLimit` | `20` | Heavy Bash jobs are refused while the 1-minute load average is over this |
| `freeGbWarn` | `20` | Warn when a watched path has less free space than this, in GB |
| `tempGbWarn` | `20` | Warn when the temp folders add up to more than this, in GB |
| `configFile` | `~/.claude-mods/machine-monitor.json` | The JSON file holding the lists below |

## Config file

Lists live in a JSON file, by default `~/.claude-mods/machine-monitor.json`. Every key is optional; a missing file or key uses the defaults. The mod reads it at the start of each session and again every 2 minutes.

| Key | Default | Meaning |
| --- | --- | --- |
| `heavyPatterns` | `remotion render`, `remotion still`, `blender -b`, `ffmpeg` | Commands the load guard holds back. A list here replaces the defaults |
| `watchPaths` | `["~"]` | Paths whose disk's free space is shown and warned about |
| `tempGlobs` | `[]` | Temp folders to add up. A `*` or `?` is allowed in the last part of a path only |

`~` at the start of a path means your home folder. Write temp paths out in full: on macOS your temp folder is the one `getconf DARWIN_USER_TEMP_DIR` prints.

Example:

```json
{
  "heavyPatterns": ["remotion render", "remotion still", "blender -b", "ffmpeg", "make-film.sh"],
  "watchPaths": ["~", "/Volumes/Scratch"],
  "tempGlobs": [
    "/var/folders/ab/xyz123/T/remotion-webpack-bundle-*",
    "/var/folders/ab/xyz123/T/remotion-v*-assets*",
    "~/Renders/tmp"
  ]
}
```

## Develop

```bash
claude plugin validate monitoring/machine-monitor
claude plugin test monitoring/machine-monitor
```
