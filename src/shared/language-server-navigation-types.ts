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

/** Semantic navigation target; same shape as definition (references/declaration reuse it). */
export type LanguageServerNavigationLocation = LanguageServerDefinitionLocation

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

/** References (Shift+F12): a list of navigation targets, same shape as definition. */
export type LanguageServerReferencesResult =
  | { ok: true; locations: LanguageServerNavigationLocation[] }
  | { ok: false; error: string; locations: [] }

/** Declaration: a list of targets (LSP allows single|[]|null; normalized to a list like definition). */
export type LanguageServerDeclarationResult =
  | { ok: true; locations: LanguageServerNavigationLocation[] }
  | { ok: false; error: string; locations: [] }

export type LanguageServerHoverResult =
  | { ok: true; hover: LanguageServerHoverContent | null }
  | { ok: false; error: string; hover: null }

/**
 * Pushed from main to renderer. The status surface is a small discriminated
 * union: `progress` is the transient `$/progress` projection (null clears),
 * `degraded` is a persistent hint (no clangd / version too low; null clears),
 * `toast` is a one-shot notification (LRU eviction) the renderer surfaces via sonner.
 */
export type LanguageServerStatusEvent =
  | { kind: 'progress'; text: string | null }
  | { kind: 'degraded'; message: string | null }
  | { kind: 'toast'; message: string }

export const LANGUAGE_SERVERS_STATUS_CHANNEL = 'languageServers:status'
