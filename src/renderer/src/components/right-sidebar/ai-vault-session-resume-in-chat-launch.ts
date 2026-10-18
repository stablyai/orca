import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import {
  CLI_CONVERSATION_ADOPTING_AGENTS,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import {
  beginStructuredAgentSessionProvisionalLaunch,
  structuredLaunchOwner
} from '@/lib/structured-agent-session-provisional-tab'
import { admitStructuredLaunchOnHost } from '@/lib/structured-agent-session-host-admission'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function activateAiVaultResumeWorkspace(workspaceId: string): boolean {
  return activateAndRevealWorkspace(workspaceId) !== false
}

/** Adopt a vault conversation into a new structured chat. The route was decided by the
 *  eligibility gate that showed this action, so it re-enters as a verdict. No legacy fallback:
 *  resume has no terminal equivalent short of the resume command, and switching surface silently
 *  would hide the refusal the user needs to see. */
export async function resumeAiVaultSessionInNewChat(
  session: AiVaultSession,
  rowAgent: CliConversationRowAgent,
  worktreeId: string,
  requestId: AgentLaunchRequestId
): Promise<void> {
  try {
    // Codex rows can live under a shared legacy home; the same preparation the terminal resume
    // runs re-pins them, and its result is what names the conversation the host will look for.
    const [preparedSession, agent] = await Promise.all([
      prepareAiVaultSessionForResume(session),
      adoptingAgentOnHost(rowAgent, worktreeId)
    ])
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId,
      agent,
      worktreeId,
      resumeFrom: { providerSessionId: preparedSession.sessionId }
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: {},
      beforeOpen: () => {
        if (useAppStore.getState().activeWorktreeId !== worktreeId) {
          return activateAiVaultResumeWorkspace(worktreeId)
        }
        return true
      }
    })
    if (launch) {
      void launch.settlement.then((settlement) => {
        if (settlement.kind === 'failed' && !settlement.notified) {
          notifyAiVaultSessionResumeInChatFailure(settlement.error, rowAgent)
        }
      })
    }
  } catch (error) {
    notifyAiVaultSessionResumeInChatFailure(error, rowAgent)
  }
}

/** The first chat the worktree's host does not refuse to take the row over, trying them in order.
 *  A host that cannot answer yet keeps the chat it was asked about, whose own launch reports it. */
async function adoptingAgentOnHost(
  rowAgent: CliConversationRowAgent,
  worktreeId: string
): Promise<TuiAgent> {
  const [first, ...rest] = CLI_CONVERSATION_ADOPTING_AGENTS[rowAgent]
  const owner = structuredLaunchOwner({ route: 'structured-native-chat' }, worktreeId)
  const selector = toRuntimeWorktreeSelector(worktreeId)
  let agent: TuiAgent = first
  for (const next of rest) {
    if (
      !owner ||
      (await admitStructuredLaunchOnHost(owner.target, selector, agent)).kind !== 'declined'
    ) {
      return agent
    }
    agent = next
  }
  return agent
}

/** The host refuses an adoption whose conversation another chat already holds, and refuses one it
 *  cannot find under any account home it recognises. Both are actionable, and neither is the
 *  generic "could not prepare" the terminal resume reports. */
function notifyAiVaultSessionResumeInChatFailure(
  error: unknown,
  rowAgent: CliConversationRowAgent
): void {
  if (hasRuntimeRpcErrorCode(error, 'agent_session_conflict')) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
        'Another chat is already holding this conversation.'
      )
    )
    return
  }
  const failure = structuredLaunchFailure(error)
  if (
    failure?.code === 'agent_session_identity_required' &&
    failure.details?.reason === 'transcriptNotFound'
  ) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.notSavedYet',
        "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
        { agent: agentLabel(rowAgent) }
      )
    )
    return
  }
  if (
    failure?.code === 'agent_session_identity_required' ||
    hasRuntimeRpcErrorCode(error, 'agent_session_identity_required')
  ) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.resumeInChatTranscriptMissing',
        "This conversation's history could not be loaded, so it cannot be resumed in chat."
      )
    )
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
