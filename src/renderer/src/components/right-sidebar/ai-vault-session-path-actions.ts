import { dshHomeFromSessionPath } from '../../../../shared/dsh-session-paths'
import { reasonixSessionLayout } from '../../../../shared/reasonix-session-paths'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
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

// Canonical DSH logs can also use the SSH host-owned file reader.
export function canOpenAiVaultSessionLogInOrca(
  session: Pick<AiVaultSession, 'filePath' | 'executionHostId'>
): boolean {
  const filePath = session.filePath?.trim()
  if (!filePath) {
    return false
  }
  if (!canUseLocalAiVaultSessionPathActions(session.executionHostId)) {
    return (
      parseExecutionHostId(session.executionHostId)?.kind === 'ssh' &&
      Boolean(dshHomeFromSessionPath(filePath) || reasonixSessionLayout(filePath))
    )
  }
  return !isAiVaultSyntheticSessionPath(filePath)
}
