export type TerminalPreviewSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
}

export type TerminalPreviewConnectResult = {
  snapshot: TerminalPreviewSnapshot | null
  /** Live bytes captured while the snapshot was being serialized. */
  replay: string[]
  /** Snapshot acquisition overflowed twice; refresh without blanking the existing view. */
  resyncRequired?: boolean
}

export type TerminalPreviewDataPayload =
  | { type: 'data'; ptyId: string; data: string; bytes: number }
  | { type: 'resync'; ptyId: string }
