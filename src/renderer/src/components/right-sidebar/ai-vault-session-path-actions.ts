import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionLogFilePath } from '../../../../shared/ai-vault-session-log-resource'
import { isAiVaultSyntheticSessionPath } from '../../../../shared/ai-vault-session-deletion'
import { revealInFileManager } from '@/lib/reveal-in-file-manager'

export { isAiVaultSyntheticSessionPath as isSyntheticAiVaultSessionPath }

export function canUseLocalAiVaultSessionPathActions(
  executionHostId: ExecutionHostId | null | undefined
): boolean {
  // Electron shell APIs use this computer's paths; SSH history paths belong to the remote host.
  return normalizeExecutionHostId(executionHostId) === LOCAL_EXECUTION_HOST_ID
}

/** File viewing needs a conversation resource on this computer, not a session storage locator. */
export function canOpenAiVaultSessionLogInOrca(
  session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'>
): boolean {
  return (
    canUseLocalAiVaultSessionPathActions(session.executionHostId) &&
    aiVaultSessionLogFilePath(session) !== null
  )
}

/** Reveals a session's log or cwd in the OS file manager, judged by the session's own host. */
export async function revealAiVaultSessionPath(
  session: Pick<AiVaultSession, 'executionHostId'>,
  path: string | null
): Promise<void> {
  if (path) {
    await revealInFileManager(path, session.executionHostId)
  }
}
