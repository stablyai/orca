export type TerminalPreviewSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
  /** Flags proven at this seq boundary; absent stays unproven, so Preview commits raw text instead of guessing zero. */
  kittyKeyboardFlags?: number
}

/** Live post-snapshot suffixes advance Kitty stacks; replayed one-time pushes must apply idempotently. */
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
