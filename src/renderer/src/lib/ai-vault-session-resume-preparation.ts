import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../shared/ai-vault-resume-preparation'
import {
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import type { AiVaultResumeCommandSession } from './ai-vault-resume-command'

export async function prepareAiVaultSessionForResume(
  session: AiVaultSession
): Promise<AiVaultSession> {
  if (session.structuredSession || !aiVaultSessionNeedsResumePreparation(session)) {
    return session
  }
  const result = await window.api.aiVault.prepareSessionResume({
    agent: session.agent,
    sessionId: session.sessionId,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: session.executionHostId
  })
  if (result.useRealCodexHome) {
    return { ...session, codexHome: null }
  }
  if (result.substituteCodexHome) {
    return { ...session, codexHome: result.substituteCodexHome }
  }
  return session
}

export function aiVaultSessionNeedsResumePreparation(
  session: Pick<AiVaultSession, 'agent' | 'codexHome' | 'executionHostId'>
): boolean {
  if (session.agent !== 'codex') {
    return false
  }
  if (isLegacySharedCodexHome(session.codexHome)) {
    return true
  }
  // Why: per-account repinning reads the LOCAL account selection, so only
  // local sessions ask; remote sessions keep their recorded home untouched.
  return (
    isPerAccountManagedCodexHome(session.codexHome) &&
    (!session.executionHostId || session.executionHostId === LOCAL_EXECUTION_HOST_ID)
  )
}

// Why: these sessions are keyed by their folder. Elsewhere Kimi rejects the resume or (1.52+) opens
// a new empty session under the same id, so the visible `cd` failure is the honest outcome.
const RESUMES_ONLY_IN_RECORDED_CWD: ReadonlySet<AiVaultSession['agent']> = new Set(['kimi', 'muse'])

/**
 * Drops an SSH session's recorded folder once its host confirms the folder is gone, so the resume
 * opens at the target workspace root, as local resumes already do (#17745). Also drops the
 * scanner-built command, whose `cd` into that folder would stop the agent from starting.
 */
export async function dropDeletedSshResumeCwd(
  session: AiVaultResumeCommandSession
): Promise<AiVaultResumeCommandSession> {
  const connectionId = getSshTargetIdForExecutionHost(session.executionHostId)
  if (!connectionId || !session.cwd || RESUMES_ONLY_IN_RECORDED_CWD.has(session.agent)) {
    return session
  }
  try {
    if (await window.api.fs.pathExists({ filePath: session.cwd, connectionId })) {
      return session
    }
  } catch {
    // Why: only a definite ENOENT proves the folder is gone; losing the host proves nothing.
    return session
  }
  const { resumeCommand: _scannerCommand, ...rest } = session
  return { ...rest, cwd: null }
}
