export type TerminalPreviewSnapshot = {
  /** Which main-side buffer served this frame; a preview retries when a fallback lags a claim. */
  source?: 'headless' | 'renderer' | 'provider'
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

/**
 * `surfaceId` names which of a webContents' previews of the same pty this
 * payload belongs to; absent when the preview connected without one.
 */
export type TerminalPreviewDataPayload =
  | { type: 'data'; ptyId: string; data: string; bytes: number; surfaceId?: string }
  | { type: 'resync'; ptyId: string; surfaceId?: string }

/**
 * Options a preview connects with. `surfaceId` lets one webContents keep
 * several independent previews of the same pty (a session grid card and the
 * dialog it opens); each surface has its own stream, snapshot boundary,
 * acknowledgements, and grid claim. Omit it for a single implicit surface.
 */
export type TerminalPreviewConnectOptions = {
  scrollbackRows?: number
  surfaceId?: string
}
