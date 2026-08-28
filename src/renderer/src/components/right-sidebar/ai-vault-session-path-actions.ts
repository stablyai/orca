import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { isAiVaultSyntheticSessionPath } from '../../../../shared/ai-vault-session-deletion'

// One definition, shared with main's delete validator; re-exported here under
// the name this module's callers already use.
export { isAiVaultSyntheticSessionPath as isSyntheticAiVaultSessionPath }

export function canUseLocalAiVaultSessionPathActions(
  executionHostId: ExecutionHostId | null | undefined
): boolean {
  // Why: Electron shell open/reveal APIs only validate paths on this computer;
  // SSH session history exposes paths that exist on the remote host instead.
  return normalizeExecutionHostId(executionHostId) === LOCAL_EXECUTION_HOST_ID
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
  return !isAiVaultSyntheticSessionPath(filePath)
}
