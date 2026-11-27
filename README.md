# claude-mods

Mods for Claude Code: small add-ons that change what the Claude app and the terminal show. Each mod is its own folder here, and the repository is a plugin marketplace, so each one installs with one line.

| Mod | What it does |
| --- | --- |
| [render-progress](render-progress/) | A pacman-style progress bar above the prompt for long renders (Remotion, Remotion Lambda, Blender, or anything that can report frames): title, bar, finish time, frames, cores. |

## Install a mod

At the prompt of a Claude Code session in a terminal:

```
/plugin install render-progress --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope puts it in every session). From a shell:

```bash
claude plugin install render-progress --marketplace a1local/claude-mods
```

Mods use Claude Code's function hooks, which are in early access, so the API may change between releases.

## License

MIT. See [LICENSE](LICENSE).
