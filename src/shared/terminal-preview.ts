export type TerminalPreviewSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
  /** Effective kitty keyboard flags the snapshot owner proved at this same
   *  `seq` boundary. Absent means unknown — Preview then keeps its tracker
   *  unproven and commits raw text rather than guessing zero. */
  kittyKeyboardFlags?: number
  /** False when the frame was replayed from on-disk history because the session
   *  is no longer running (the daemon dies with the machine, so after a reboot
   *  every not-yet-reopened pane lands here). Read-only: there is no PTY to
   *  type into, and no live bytes will follow. */
  live?: boolean
}

/**
 * How the renderer must apply one buffered chunk. `live` is a proven
 * post-snapshot suffix, so kitty pushes advance the stack; `replay` is
 * redelivery that may repeat the application's one-time push, so it applies
 * idempotently (see TerminalKittyKeyboardModeTracker.scanReplay).
 */
export type TerminalPreviewReplayChunk = {
  data: string
  mode: 'live' | 'replay'
}

export type TerminalPreviewConnectResult = {
  snapshot: TerminalPreviewSnapshot | null
  /** Live bytes captured while the snapshot was being serialized. */
  replay: TerminalPreviewReplayChunk[]
  /** Snapshot acquisition overflowed twice; refresh without blanking the existing view. */
  resyncRequired?: boolean
}

export type TerminalPreviewDataPayload =
  | { type: 'data'; ptyId: string; data: string; bytes: number }
  | { type: 'resync'; ptyId: string }
