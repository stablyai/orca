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
