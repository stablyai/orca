export type TerminalScrollSettings = {
  /** When true (the default), typing or pasting in a scrolled-up pane jumps to the latest output. */
  terminalScrollOnUserInput: boolean
  /** Scrollbar width in CSS pixels; the 7px default is the slim bar. */
  terminalScrollbarWidth: number
  /** Keeps the scrollbar shown instead of fading it out until hover or scroll. */
  terminalScrollbarAlwaysVisible: boolean
}

export const MIN_TERMINAL_SCROLLBAR_WIDTH = 7
export const DEFAULT_TERMINAL_SCROLLBAR_WIDTH = 7
export const MAX_TERMINAL_SCROLLBAR_WIDTH = 20

export function normalizeTerminalScrollbarWidth(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(
        MAX_TERMINAL_SCROLLBAR_WIDTH,
        Math.max(MIN_TERMINAL_SCROLLBAR_WIDTH, Math.round(value))
      )
    : DEFAULT_TERMINAL_SCROLLBAR_WIDTH
}
