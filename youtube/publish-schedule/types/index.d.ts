/** One entry of the schedule file. */
export type ScheduleItem = {
  /** Local time, `2026-11-28T14:00` (seconds allowed, no zone). */
  at: string
  channel: string
  kind: 'film' | 'short'
  title: string
  /** Set by `/publishing done <n>`, or by hand. */
  done?: boolean
  /** Already scheduled on the platforms: counts as done once its time has passed. */
  scheduled?: boolean
  platforms?: string[]
  /** The channel's colour, a theme key such as `suggestion`; left out, the name picks a steady one. */
  color?: string
}

export type Status = 'done' | 'overdue' | 'soon' | 'later'

/** A schedule entry with its time worked out. */
export type Row = ScheduleItem & {
  /** `at|channel|title`: stable across re-reads, what `/publishing done <n>` marks. */
  id: string
  /** Epoch milliseconds. */
  atMs: number
}

/** The shared row above the prompt (see STYLE/look.tsx): this mod's items on it. */
export type DeckPiece = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Deck = { items: { id: string; rank: number; tag?: string; pieces: DeckPiece[] }[]; reset: number }
/** Which item the shared row shows and which were closed with ✕, when this mod draws it. */
export type DeckView = { at: number; resets: number; hidden: string[] }

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
      /** This mod's items on the shared row above the prompt; `/publishing` bumps `reset`. */
      deck: Deck
      /** The shared row's page and closed items, when this mod is the one drawing it. */
      view: DeckView
    }
  }
}
