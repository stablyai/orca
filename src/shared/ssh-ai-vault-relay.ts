export const SSH_AI_VAULT_LIST_SESSIONS_METHOD = 'aiVault.listSessions' as const
export const SSH_AI_VAULT_RESOLVE_SESSION_TITLES_METHOD = 'aiVault.resolveSessionTitles' as const
export const SSH_AI_VAULT_LIST_SESSIONS_TIMEOUT_MS = 130_000
export const SSH_AI_VAULT_RESOLVE_SESSION_TITLES_TIMEOUT_MS = 15_000
export const SSH_AI_VAULT_LIST_LIMIT_MAX = 1000
export const SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096

export type SshAiVaultRelayListParams = {
  limit?: number
  unlimited?: boolean
  force?: boolean
  scopePaths?: string[]
  scopePathsTruncated?: boolean
}

export type SshAiVaultRelayTitleParams = {
  requests: {
    agent: 'claude' | 'codex'
    sessionId: string
    transcriptPath?: string
  }[]
}
