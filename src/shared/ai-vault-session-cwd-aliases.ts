import type { AiVaultSession } from './ai-vault-types'
import { sessionFileExecutionNamespace } from './ai-vault-scope-cwd-match'
import { normalizeRuntimePathForComparison } from './cross-platform-path'
import { normalizeExecutionHostId } from './execution-host'

/** A relationship or provider id alone does not prove that two rows recorded the same directory. */
export function withAiVaultSessionCwdAliases(
  session: AiVaultSession,
  source: Pick<AiVaultSession, 'agent' | 'cwd' | 'cwdAliases' | 'executionHostId' | 'filePath'>
): AiVaultSession {
  if (
    !source.cwdAliases?.length ||
    !session.cwd ||
    !source.cwd ||
    session.agent !== source.agent ||
    normalizeExecutionHostId(session.executionHostId) !==
      normalizeExecutionHostId(source.executionHostId) ||
    sessionFileExecutionNamespace(session.filePath) !==
      sessionFileExecutionNamespace(source.filePath) ||
    normalizeRuntimePathForComparison(session.cwd) !== normalizeRuntimePathForComparison(source.cwd)
  ) {
    return session
  }
  return {
    ...session,
    cwdAliases: [...new Set([...(session.cwdAliases ?? []), ...source.cwdAliases])]
  }
}
