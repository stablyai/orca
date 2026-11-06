export type TerminalQuitSessionSettings = {
  /** Quit stops local daemon terminal sessions instead of keeping them for warm reattach; update and relaunch quits keep them. */
  stopTerminalSessionsOnQuit?: boolean
}
