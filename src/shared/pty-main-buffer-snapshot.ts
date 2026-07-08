// Payload for the pty:getMainBufferSnapshot IPC.
//
// STA-1282 gate #5 requires a real serialization/RPC error to be distinguishable
// from a nil mirror: the handler resolves `null` for a nil mirror but REJECTS on
// a genuine error (instead of the old swallow-to-null), so the eviction remount
// fail-open counter can tell a structural replay failure from a legitimately
// blank pane.

export type PtyMainBufferSnapshotPayload = {
  data: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless' | 'renderer'
  alternateScreen?: boolean
  // #7329: the partial escape-sequence tail split across the snapshot boundary,
  // replayed after the reset so a mid-escape cut does not corrupt the terminal.
  pendingEscapeTailAnsi?: string
}
