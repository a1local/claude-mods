# claude-mods

Mods for Claude Code: small add-ons that change what the Claude app and the terminal show, and what Claude is allowed to run. They're grouped by what they're for. Each mod is its own folder, and the repository is a plugin marketplace, so each one installs with one line.

They work as a set: each has one slash command that answers in the chat in the same rounded box, rows above the prompt close with a ✕, and colours and bars mean the same thing everywhere. See [STYLE.md](STYLE/STYLE.md).

| Command | Mod |
| --- | --- |
| `/renders` | render-progress |
| `/machine` | machine-monitor |
| `/publishing` | publish-schedule |
| `/channel-stats` | channel-stats |
| `/guard` | command-guard |

## Rendering

For long video, animation and 3D renders. [More](rendering/)

| Mod | What it does |
| --- | --- |
| [render-progress](rendering/render-progress/) | A pacman-style progress bar above the prompt for every render on the computer (Remotion, Remotion Lambda, Blender or any command that can report frames): title, bar, finish time, frames, cores. It also spots `remotion render` and `blender -b` runs nobody registered. A notification when one finishes, fails or stalls. |

## Monitoring

For keeping one machine usable while heavy jobs and several sessions share it. [More](monitoring/)

| Mod | What it does |
| --- | --- |
| [machine-monitor](monitoring/machine-monitor/) | A status line with load, GPU, swap and free disk, and `/machine` for bars against each limit. It holds back heavy jobs (renders, ffmpeg) while load is over a limit, and warns once when free space drops or temp folders grow past a limit. |

## YouTube

For channels that publish on a schedule. [More](youtube/)

| Mod | What it does |
| --- | --- |
| [publish-schedule](youtube/publish-schedule/) | `/publishing` lists today's and tomorrow's uploads (films, Shorts, other platforms) with what's due, overdue or done; `/publishing done <n>` ticks one off; a one-line reminder above the prompt when something is due within the hour. |
| [channel-stats](youtube/channel-stats/) | Subscribers and views for your channels in the status line, against the Partner Program's 1,000 subscribers, with a daily change table. Needs a free YouTube Data API key. |

## Safety

For rules Claude should never break, in any session. [More](safety/)

| Mod | What it does |
| --- | --- |
| [command-guard](safety/command-guard/) | Your "never run this" rules in one file. A matching command, file write or edit is refused with your reason and what to do instead. |

## Install a mod

At the prompt of a Claude Code session in a terminal, using the mod's name from the tables:

```
/plugin install render-progress --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope puts it in every session). From a shell:

```bash
claude plugin install render-progress --marketplace a1local/claude-mods
```

Each mod's README lists its settings. Settings that hold your own data (paths, channels, rules, schedules) live in files outside the repo, by default in `~/.claude-mods/` or `~/.render-progress/`.

Mods use Claude Code's function hooks, which are in early access, so the API may change between releases.

## License

MIT. See [LICENSE](LICENSE).
