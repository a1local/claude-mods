# command-guard

Turns your "never run X" rules into a guard that every Claude Code session obeys, instead of repeating them in notes and hoping they are read.

You write each rule once, as a regular expression and a reason. When Claude tries a Bash command that matches, the command does not run: Claude gets your reason back as the tool's error, and the reason says what to do instead, so it can carry on the right way. A rule can also check the files Claude writes or edits.

- A small toast names the rule each time one refuses a call.
- `/guard` lists the active rules and how many times each refused a call this session.
- Rules live in one private JSON file outside any repository. The mod reads it again as soon as you save it.
- A broken rules file never blocks your work. If the file is not valid JSON, a rule has a bad pattern, or a check fails, calls go through and a toast says what is wrong (once, not on every command).

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install command-guard --marketplace a1local/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install command-guard --marketplace a1local/claude-mods
```

Then create your rules file (below). With no file, nothing is checked.

## The rules file

Default location: `~/.claude-mods/command-guard.json`. It holds `{ "rules": [...] }` (a bare list of rules works too). Each rule:

| Field | Meaning |
| --- | --- |
| `pattern` | A JavaScript regular expression, as a JSON string (so `\b` is written `\\b`) |
| `reason` | What Claude reads when the rule refuses a call. Say why, and what to do instead |
| `name` | Optional. Shown in the toast and in `/guard`. Default `rule 1`, `rule 2`, ... |
| `flags` | Optional. RegExp flags, such as `"i"` for any case. `g` and `y` are ignored |
| `tool` | Optional. `Bash` (the default) checks the command. `Write` checks the file path and the new file's content. `Edit` checks the file path and the replacement text |

The first rule that matches refuses the call. An example:

```json
{
  "rules": [
    {
      "name": "no-force-push",
      "pattern": "\\bgit\\s+push\\b.*\\s(-f|--force)(\\s|$)",
      "reason": "Never force-push. Pull and merge, or push a new commit. If history really must change, ask the user first."
    },
    {
      "name": "no-mass-kill",
      "pattern": "(^|[;&|(])\\s*(sudo\\s+)?(pkill|killall)\\b",
      "reason": "Other jobs run on this computer. Stop only a process you started, by its PID (kill <pid>)."
    },
    {
      "name": "no-env-files",
      "tool": "Write",
      "pattern": "(^|/)\\.env(\\.[^/]*)?$",
      "reason": "Secrets are not written by Claude. Tell the user which variable to add to .env and let them do it."
    }
  ]
}
```

Tips for patterns that only catch what you mean:

- Anchor a command name to where a command starts, as `no-mass-kill` does with `(^|[;&|(])\s*`, so `grep -rn pkill notes/` still runs.
- Test each pattern against commands that should and should not match before relying on it, for example with `node -e 'console.log(new RegExp(process.argv[1]).test(process.argv[2]))' '<pattern>' '<command>'`.
- A guard reads the text of the command. It cannot see what a script does inside, or which folder a command runs in unless the command says so (`cd site && ...`).

## Settings

In `/config` (or `pluginConfigs` in settings):

| Key | Default | Meaning |
| --- | --- | --- |
| `rulesFile` | empty, meaning `~/.claude-mods/command-guard.json` | Path of the rules file. `~` stands for your home folder |
| `toasts` | `true` | A toast naming the rule each time one refuses a call. Problems with the rules file are always shown |

## Developing

`claude plugin test command-guard` runs the tests, and `claude plugin validate command-guard` checks the mod. Claude Code's function hooks are in early access, so the API may change between releases.

## License

MIT. See [LICENSE](LICENSE).
