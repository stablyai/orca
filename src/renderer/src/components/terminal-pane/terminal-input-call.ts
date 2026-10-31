/** Original call metadata travels with existing retained bytes, never a second action queue. */
export type TerminalInputCall = {
  onEligible: (ptyId: string) => void
  onDispatch: (ptyId: string) => void
}
