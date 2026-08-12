export type TerminalPasteSource =
  | 'keyboard'
  | 'paste-event'
  | 'app-menu'
  | 'context-menu'
  | 'right-click'
  | 'middle-click'
  | 'programmatic'

export type TerminalPasteRuntime = {
  platform: NodeJS.Platform
  runtimeKey: string
  kind: 'local' | 'wsl' | 'ssh' | 'remote-runtime'
  isWindowsConpty?: boolean
}

export type TerminalPasteTarget = {
  kind: 'terminal'
  paneId: number
  leafId: string
  ptyId: string | null
  runtime: TerminalPasteRuntime
}

export type TerminalPastePayload = {
  plainText: string
  source: TerminalPasteSource
  byteLength: number
  lineCount: number
  hasRichText: boolean
  hasControlSequences: boolean
}

export type TerminalPastePlan = {
  target: TerminalPasteTarget
  payload: TerminalPastePayload
  mode: 'direct' | 'chunked' | 'bracketed-terminal' | 'reject'
  // Why: 'terminal-cr' marks plans whose paste bytes Orca constructs itself, so
  // every write path applies xterm's native \r?\n -> \r before ConPTY sees LF.
  newlinePolicy: 'preserve' | 'terminal-cr'
  runtimeKey: string
  maxChunkBytes?: number
  bracketed: boolean
  redactedDiagnostic: string
  rejectReason?: TerminalPasteExecutionReason
}

export type TerminalPasteTextOptions = {
  forceBracketedPaste?: boolean
  forceBracketedPasteForMultiline?: boolean
  recoverImagePasteWebglAtlas?: boolean
}

export type TerminalPasteExecutionReason =
  | 'operation-timeout'
  | 'paste-rejected'
  | 'payload-too-large'
  | 'pty-writer-unavailable'
  | 'stale-target'
  | 'target-disconnected'

export type TerminalPasteExecutionResult = {
  status: 'pasted' | 'rejected' | 'cancelled'
  chunksWritten: number
  diagnostic: string
  durationMs: number
  reason?: TerminalPasteExecutionReason
}
