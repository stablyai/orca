import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { isAiVaultOwnershipRefusal } from '@/lib/ai-vault-resume-refusal'
import { aiVaultCliForkHostTooOldMessage } from '@/lib/ai-vault-session-resume-preparation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getAgentForkArgv, isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import { agentForksThroughChat } from '../../../../shared/agent-resume-argv'
import { getAiVaultAgentProviderSession } from '@/lib/ai-vault-resume-command'

/** Offer a CLI copy only for native-owned sessions with a chat copy route or buildable CLI command (Pi needs a file). */
export function aiVaultSessionCliForkWorktreeId(
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'filePath' | 'structuredSession'>,
  resume: { worktreeId: string | null | undefined; disabled: boolean }
): string | null {
  if (!session.structuredSession || resume.disabled || !resume.worktreeId) {
    return null
  }
  const providerSession = getAiVaultAgentProviderSession(session)
  return providerSession &&
    isResumableTuiAgent(session.agent) &&
    (agentForksThroughChat(session.agent) || getAgentForkArgv(session.agent, providerSession))
    ? resume.worktreeId
    : null
}

/** Older host guards reject forks as second writers; ask for an update on that refusal. */
export function describeAiVaultCliForkFailure(message: string): string {
  const code = compactIpcErrorMessage(message)
  return isAiVaultOwnershipRefusal(message) ? aiVaultCliForkHostTooOldMessage() : (code ?? message)
}
