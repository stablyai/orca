// Semantic IPC payloads for the editor language-server surface (spec D2/D3:
// the renderer never sees an LSP message). Coordinates are 0-based line/
// character pairs in the negotiated LSP basis (UTF-16); the ±1 Monaco
// conversion lives in the renderer providers only.

/** 0-based line/character, UTF-16 code units (matches Monaco after ±1). */
export type LanguageServerPosition = {
  line: number
  character: number
}

/** 0-based, end-exclusive-in-practice range (LSP semantics). */
export type LanguageServerRange = {
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

/** One incremental edit, translated from the model change event as-is. */
export type LanguageServerDocumentChange = {
  range: LanguageServerRange
  rangeLength?: number
  text: string
}

export type LanguageServerDefinitionLocation = {
  path: string
  range: LanguageServerRange
}

export type LanguageServerHoverContent = {
  kind: 'markdown' | 'plaintext'
  value: string
}

export type LanguageServerDocumentResult =
  | { ok: true; version?: number }
  | { ok: false; error: string }

export type LanguageServerDefinitionResult =
  | { ok: true; locations: LanguageServerDefinitionLocation[] }
  | { ok: false; error: string; locations: [] }

export type LanguageServerHoverResult =
  | { ok: true; hover: LanguageServerHoverContent | null }
  | { ok: false; error: string; hover: null }

/** Pushed from main: `$/progress` projection; null clears the status line. */
export type LanguageServerStatusEvent = {
  text: string | null
}

export const LANGUAGE_SERVERS_STATUS_CHANNEL = 'languageServers:status'
