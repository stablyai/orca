import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  isLegacySharedCodexHome,
  isPerAccountManagedCodexHome
} from '../../../shared/ai-vault-resume-preparation'
import { parseExecutionHostId } from '../../../shared/execution-host'

export async function prepareAiVaultSessionForResume(
  session: AiVaultSession
): Promise<AiVaultSession> {
  if (!session.structuredSession && !aiVaultSessionNeedsResumePreparation(session)) {
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
  // Why: per-account repinning reads the account selection of the host that owns the row, and the
  // preparation RPC runs there — this machine's for a local row, the peer's own for a paired one.
  // An `ssh:` host has no such selection to read, so it keeps its recorded home untouched.
  return isPerAccountManagedCodexHome(session.codexHome) && ownsCodexAccountSelection(session)
}

function ownsCodexAccountSelection(session: Pick<AiVaultSession, 'executionHostId'>): boolean {
  if (!session.executionHostId) {
    return true
  }
  const kind = parseExecutionHostId(session.executionHostId)?.kind
  return kind === 'local' || kind === 'runtime'
}
