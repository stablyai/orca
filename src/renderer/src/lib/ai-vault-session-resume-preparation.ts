import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export async function prepareAiVaultSessionForResume(
  session: AiVaultSession
): Promise<AiVaultSession> {
  if (!aiVaultSessionNeedsResumePreparation(session)) {
    return session
  }
  const result = await window.api.aiVault.prepareSessionResume({
    agent: session.agent,
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
