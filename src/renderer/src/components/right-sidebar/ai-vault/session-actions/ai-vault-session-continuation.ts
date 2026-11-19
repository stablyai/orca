import {
  buildAgentSessionContinuationPrompt,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session/context/agent-session-continuation'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
  isAiVaultDatabaseAgent
} from '../../../../../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { prepareAiVaultSessionContinuation } from '../../../../../../shared/agent-session/context/ai-vault-session-continuation'
import { withTimeout } from '../../../../../../shared/concurrency/promise-timeout-fallback'

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined
): boolean {
  return Boolean(
    targetWorktreeId &&
    // A database row's host saves its conversation when Hand Off opens, even with no preview text.
    (isAiVaultDatabaseAgent(session.agent) ||
      (!isAiVaultDatabaseAgent(session.agent) && session.filePath.trim()) ||
      session.previewMessages.some((message) => message.text.trim()))
  )
}

type AiVaultSessionContinuationTarget = {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
}

/** A database row's host saves this one conversation first; null when nothing usable came back. */
export async function loadDatabaseAiVaultSessionContinuation(
  target: AiVaultSessionContinuationTarget
): Promise<AgentSessionContinuationRequest | null> {
  const { session } = target
  const saved = await withTimeout(
    window.api.aiVault.prepareSessionHandoff({
      agent: session.agent,
      filePath: session.filePath,
      sessionId: session.sessionId,
      executionHostId: session.executionHostId
    }),
    AI_VAULT_SESSION_HANDOFF_TIMEOUT_MS,
    {}
  )
  const request = prepareAiVaultSessionContinuation({
    ...target,
    savedTranscriptPath: saved.transcriptPath
  })
  return buildAgentSessionContinuationPrompt(request.source, 'focused') ? request : null
}

export { prepareAiVaultSessionContinuation } from '../../../../../../shared/agent-session/context/ai-vault-session-continuation'
