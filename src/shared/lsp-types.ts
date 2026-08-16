/** Wire contract for the local LSP bridge (renderer ↔ main). Local workspaces
 *  only — remote/SSH/web surfaces have no `lsp` API and degrade to no LSP. */

export const LSP_REQUEST_METHODS = [
  'textDocument/hover',
  'textDocument/definition',
  'textDocument/references',
  'textDocument/completion',
  'textDocument/diagnostic'
] as const

export type LspRequestMethod = (typeof LSP_REQUEST_METHODS)[number]

export type LspOpenDocumentArgs = {
  /** Absolute local path of the file being edited. */
  filePath: string
  /** Absolute local path of the workspace root the server is scoped to. */
  rootPath: string
  /** Monaco language id (e.g. 'typescript', 'python'). */
  languageId: string
  /** Full document text at open time. */
  text: string
}

export type LspOpenDocumentResult = {
  sessionId: string | null
  /** Canonical file:// URI for filePath, computed by main so both sides agree. */
  fileUri: string | null
  /** Which catalog server answered (e.g. 'tsgo'), for the editor status badge. */
  serverId: string | null
  /** True when the server wants pull diagnostics (textDocument/diagnostic)
   *  instead of pushing publishDiagnostics. */
  pullDiagnostics: boolean
}

export type LspChangeDocumentArgs = {
  sessionId: string
  fileUri: string
  text: string
}

export type LspCloseDocumentArgs = {
  sessionId: string
  fileUri: string
}

export type LspRequestArgs = {
  sessionId: string
  method: LspRequestMethod
  params: unknown
}

export type LspDiagnosticsPayload = {
  sessionId: string
  fileUri: string
  diagnostics: unknown[]
}
