// Renderer-facing Matrix adapter contract. Lives in shared/ so the preload
// bridge, the PreloadApi type, and the settings pane import one definition that
// the web tsconfig compiles (src/main/matrix/types.ts is the main-process
// authority and mirrors these shapes; this module is the cross-boundary view).

export type MatrixViewer = {
  userId: string
  displayName?: string
  homeserver: string
}

export type MatrixConnectionStatus = {
  ok: boolean
  enabled: boolean
  running: boolean
  viewer?: MatrixViewer
  roomId?: string
  error?: string
}

export type MatrixOutboundResult = { ok: true; eventId: string } | { ok: false; error: string }
