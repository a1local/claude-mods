export type RenderRow = {
  /** The registry file's name. */
  id: string
  /** Shown as the title's colour; the same channel always gets the same colour. Empty for none. */
  channel: string
  /** The `color=` line: the title's colour (a theme key such as `success`, a name, or hex). */
  color?: string
  /** The `title=` line, or the registry file's name. */
  title: string
  kind: 'remotion' | 'lambda' | 'command' | 'detected'
  stage: 'bundling' | 'uploading' | 'rendering' | 'joining' | 'done' | 'failed' | 'stalled'
  /** 0..1, or null when not measurable (Lambda, bundling). */
  fraction: number | null
  framesDone: number
  framesTotal: number
  elapsedSec: number
  /** Seconds left, estimated from the rate so far; null when unknown. */
  leftSec: number | null
  /** CPU cores the render's processes are using now (ps %CPU / 100); null when unknown. */
  cores?: number | null
}

/** The shared row above the prompt (see STYLE/look.tsx): this mod's items on it. */
export type DeckPiece = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Deck = { items: { id: string; rank: number; pieces: DeckPiece[] }[]; reset: number }
/** Which item the shared row shows and which were closed with ✕, when this mod draws it. */
export type DeckView = { at: number; resets: number; hidden: string[] }

declare module 'claude-code' {
  interface PluginState {
    'render-progress': { rows: RenderRow[]; deck: Deck; view: DeckView }
  }
}
