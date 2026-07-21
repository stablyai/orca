import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { isLegacySharedCodexHome } from '../../../shared/ai-vault-resume-preparation'

export async function prepareAiVaultSessionForResume(
  session: AiVaultSession
): Promise<AiVaultSession> {
  if (session.agent !== 'codex' || !isLegacySharedCodexHome(session.codexHome)) {
    return session
  }
  const result = await window.api.aiVault.prepareSessionResume({
    agent: session.agent,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: session.executionHostId
  })
  return result.useRealCodexHome ? { ...session, codexHome: null } : session
}
