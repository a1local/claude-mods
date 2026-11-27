/** One entry of the schedule file. */
export type ScheduleItem = {
  /** Local time, `2026-11-28T14:00` (seconds allowed, no zone). */
  at: string
  channel: string
  kind: 'film' | 'short'
  title: string
  /** Set by the Done button, or by hand. */
  done?: boolean
  /** Already scheduled on the platforms: counts as done once its time has passed. */
  scheduled?: boolean
  platforms?: string[]
}

export type Status = 'done' | 'overdue' | 'soon' | 'later'

/** A schedule entry with its time worked out. */
export type Row = ScheduleItem & {
  /** `at|channel|title`: stable across re-reads, the Done button's address. */
  id: string
  /** Epoch milliseconds. */
  atMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'publish-schedule': {
      rows: Row[]
      /** When the file was last read: each minute's read redraws the statuses. */
      nowMs: number
      /** Minutes east of UTC, from `date +%z`. */
      offsetMin: number
      /** Why the file could not be read, or '' when it was. */
      problem: string
    }
  }
}
