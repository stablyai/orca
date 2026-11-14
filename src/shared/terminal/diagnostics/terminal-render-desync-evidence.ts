/** The capture id becomes a directory name under userData, so main validates it before
 *  use. Both sides import this so the renderer cannot mint an id main will reject. */
export const TERMINAL_RENDER_DESYNC_CAPTURE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/

export type TerminalRenderDesyncEvidencePhase = 'corrupt' | 'healed'

export type WriteTerminalRenderDesyncEvidenceArgs = {
  captureId: string
  phase: TerminalRenderDesyncEvidencePhase
  pngDataUrl: string
  metadata?: Record<string, unknown>
}

export type WriteTerminalRenderDesyncEvidenceResult = {
  directory: string
  pngPath: string
  metadataPath: string | null
}
