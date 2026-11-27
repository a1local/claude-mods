/** One rule as written in the rules file. */
export type Rule = {
  /** Shown in the toast and in /guard. Default: `rule <n>`. */
  name: string
  /** A JavaScript regular expression, as a string. */
  pattern: string
  /** RegExp flags such as `i`. `g` and `y` are dropped. */
  flags?: string
  /** What Claude reads when the rule refuses a call: why, and what to do instead. */
  reason: string
  /** Which tool the rule checks: `Bash` (the command, the default), `Write` (path and content) or `Edit` (path and new text). */
  tool: 'Bash' | 'Write' | 'Edit'
}

declare module 'claude-code' {
  interface PluginState {
    /** Times each rule (by name) refused a call this session. */
    'command-guard': { fired: Record<string, number> }
  }
}
