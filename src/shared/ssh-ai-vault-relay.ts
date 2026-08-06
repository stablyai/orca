export const SSH_AI_VAULT_LIST_SESSIONS_METHOD = 'aiVault.listSessions' as const
export const SSH_AI_VAULT_LIST_SESSIONS_TIMEOUT_MS = 130_000
export const SSH_AI_VAULT_LIST_LIMIT_MAX = 1000
export const SSH_AI_VAULT_SCOPE_PATH_MAX_LENGTH = 4096

export type SshAiVaultRelayListParams = {
  limit?: number
  unlimited?: boolean
  force?: boolean
  scopePaths?: string[]
  scopePathsTruncated?: boolean
}
