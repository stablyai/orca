import type { AiVaultListArgs } from './ai-vault-types'
import { requestedAiVaultSessionDepth } from './ai-vault-session-depth'

/** The local cache and coordinator entry for one scope and scan depth. */
export function aiVaultLocalScanKey(args?: AiVaultListArgs): string {
  return JSON.stringify({
    key: aiVaultLocalScanScopeKey(args),
    depth: requestedAiVaultSessionDepth(args)
  })
}

export function aiVaultLocalScanScopeKey(args?: AiVaultListArgs): string {
  return JSON.stringify({
    selectedSessionId: args?.selectedSessionId,
    scopePaths: [...new Set(args?.scopePaths ?? [])].sort(),
    includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions === true
  })
}
