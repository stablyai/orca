export const LANGUAGE_SERVER_IDS = ['typescript', 'ruby-lsp', 'solargraph'] as const
export type LanguageServerId = (typeof LANGUAGE_SERVER_IDS)[number]

export type RepoLanguageServerSettings = {
  /** Absent or false = off. Enabling a server is the trust decision for this repo. */
  enabled?: Partial<Record<LanguageServerId, boolean>>
  /** argv override for user-installed servers, e.g. ['bundle', 'exec', 'ruby-lsp']. */
  command?: Partial<Record<LanguageServerId, string[]>>
}

export type LanguageServerProbe =
  | { status: 'bundled' }
  | { status: 'installed'; version: string }
  | { status: 'missing' }
  | { status: 'unsupported-host' }

export type LspOpenArgs = { requestId: string; worktreeId: string; languageId: string }
export type LspOpenFailureReason =
  | 'invalid-worktree'
  | 'unsupported-host'
  | 'disabled'
  | 'unavailable'
export type LspOpenResult =
  | { ok: true; sessionKey: string }
  | { ok: false; reason: LspOpenFailureReason }

export type LspProbeArgs = { repoId: string }
export type LspProbeResult = Partial<Record<LanguageServerId, LanguageServerProbe>>

/** Main → preload IPC channel that carries the session MessagePort. */
export const LSP_PORT_CHANNEL = 'lsp:port'
/** Preload → main-world window message type that carries the same port. */
export const LSP_PORT_WINDOW_MESSAGE = 'orca-lsp-port'
