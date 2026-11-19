export type TerminalScrollSettings = {
  /** When true (the default), typing or pasting in a scrolled-up pane jumps to the latest output. */
  terminalScrollOnUserInput: boolean
  /** Scrollbar width in CSS pixels; the 7px default is the slim bar. */
  terminalScrollbarWidth: number
  /** Keeps the scrollbar shown instead of fading it out until hover or scroll. */
  terminalScrollbarAlwaysVisible: boolean
}
