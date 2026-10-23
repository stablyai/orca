import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { isAiVaultOwnershipRefusal } from '@/lib/ai-vault-resume-refusal'
import { aiVaultCliForkHostTooOldMessage } from '@/lib/ai-vault-session-resume-preparation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getAgentForkArgv, isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import { agentForksThroughChat } from '../../../../shared/agent-resume-argv'
import { getAiVaultAgentProviderSession } from '@/lib/ai-vault-resume-command'

/**
 * Where the terminal opens its copy of a conversation native chat owns, or null when the row
 * does not offer it. A row no chat owns already resumes in the CLI through plain Resume. A row offers
 * it when its chat makes the copy (OpenCode, OMP), or when its CLI's copy command can be built (Pi's
 * needs the session file, which a remote search hit doesn't carry).
 */
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

/** The toast for a failed terminal fork. Only a host whose guard predates the fork refuses
 *  the fork as a second writer, so that refusal asks for the update instead of naming a code. */
export function describeAiVaultCliForkFailure(message: string): string {
  // The desktop preparation's refusal arrives inside Electron's IPC wrapper.
  const code = compactIpcErrorMessage(message)
  return isAiVaultOwnershipRefusal(message) ? aiVaultCliForkHostTooOldMessage() : (code ?? message)
}
