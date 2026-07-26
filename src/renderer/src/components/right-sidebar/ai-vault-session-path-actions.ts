import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'

export function canUseLocalAiVaultSessionPathActions(
  executionHostId: ExecutionHostId | null | undefined
): boolean {
  // Why: Electron shell open/reveal APIs only validate paths on this computer;
  // SSH session history exposes paths that exist on the remote host instead.
  return normalizeExecutionHostId(executionHostId) === LOCAL_EXECUTION_HOST_ID
}

export function isSyntheticAiVaultSessionPath(filePath: string): boolean {
  // Why: newer OpenCode sessions use a synthetic `<database>#<sessionId>`
  // scanner identity backed by SQLite — not a real filesystem path. A '#'
  // session marker never appears in a genuine local transcript path, so it is
  // a reliable v1 signal that there is no single file to open in Orca.
  return filePath.includes('#')
}

/**
 * Whether AI Vault `View Log` / `Open Log` can open this session's log inside
 * Orca as a read-only tab: a non-blank, local, single-file (non-synthetic)
 * path. Remote/runtime and synthetic identities are withheld until AI Vault has
 * a provider-owned log-resource contract.
 */
export function canOpenAiVaultSessionLogInOrca(
  session: Pick<AiVaultSession, 'filePath' | 'executionHostId'>
): boolean {
  const filePath = session.filePath?.trim()
  if (!filePath) {
    return false
  }
  if (!canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
    return false
  }
  return !isSyntheticAiVaultSessionPath(filePath)
}
