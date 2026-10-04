/** Wire contract for GitHub Copilot ghost text (renderer <-> main). Local
 *  workspaces only; SSH, remote-runtime and web surfaces have no such API. */

/** Documents larger than this are never sent to the Copilot language server. */
export const COPILOT_MAX_DOCUMENT_CHARS = 1_000_000

/** Copilot's didChangeStatus kinds; 'Error' also means signed out. */
export type CopilotStatusKind = 'Normal' | 'Error' | 'Warning' | 'Inactive'

export type CopilotStatus = {
  /** False when copilot-language-server is not on PATH. */
  installed: boolean
  kind: CopilotStatusKind | null
  message: string
  busy: boolean
  /** GitHub login once checkStatus reports a signed-in user. */
  user: string | null
  /** True after a device-flow sign-in ended without a signed-in user; cleared when sign-in restarts. */
  signInFailed: boolean
}

export type CopilotOpenDocumentArgs = {
  /** Absolute local path of the file being edited. */
  filePath: string
  /** Absolute local path of the workspace root containing filePath. */
  rootPath: string
  /** Monaco language id (e.g. 'typescript'). */
  languageId: string
  /** Full document text at open time. */
  text: string
}

export type CopilotOpenDocumentResult = {
  /** Canonical file:// URI minted by main; null when Copilot is unavailable or signed out. */
  fileUri: string | null
}

export type CopilotChangeDocumentArgs = { fileUri: string; text: string }

export type CopilotCloseDocumentArgs = { fileUri: string }

export type CopilotInlineCompletionArgs = {
  fileUri: string
  /** 0-based LSP position. */
  position: { line: number; character: number }
  trigger: 'automatic' | 'explicit'
  formattingOptions: { tabSize: number; insertSpaces: boolean }
}

export type CopilotInlineCompletionResult = {
  /** False when main no longer holds the document (server restarted or shut down). */
  opened: boolean
  /** Raw textDocument/inlineCompletion result; the renderer validates it. */
  result: unknown
}

export type CopilotSignInResult =
  | { state: 'alreadySignedIn'; user: string | null }
  | { state: 'pending'; userCode: string; verificationUri: string | null }
  | { state: 'unavailable' }
