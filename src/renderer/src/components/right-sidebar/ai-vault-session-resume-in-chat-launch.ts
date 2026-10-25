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
} from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { admitStructuredLaunchOnHost } from '@/lib/structured-agent-session-host-admission'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { NativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'

/** A chat the resumed one takes the place of: it opens right after that tab. */
export type AiVaultChatReplacement = {
  afterTabId: string
  /** Told the new tab's id once it opens. */
  focusIntent: NativeChatComposerFocusIntent
  /** Called exactly once; null when no launch began. True: it accounted for a failure itself,
   *  so no failure toast. */
  onSettled: (settlement: StructuredAgentLaunchSettlement | null) => boolean
}

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
  requestId: AgentLaunchRequestId,
  replacing?: AiVaultChatReplacement
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
    const selection = useAppStore.getState()
    const waitForCreate = workspaceHasSleepingAgentSessions(selection, worktreeId)
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: {},
      ...(replacing
        ? { afterTabId: replacing.afterTabId, focusIntent: replacing.focusIntent }
        : {}),
      beforeOpen: waitForCreate
        ? undefined
        : () => {
            if (useAppStore.getState().activeWorktreeId !== worktreeId) {
              return activateAiVaultResumeWorkspace(worktreeId)
            }
            return true
          }
    })
    if (!launch) {
      replacing?.onSettled(null)
      return
    }
    void launch.settlement.then((settlement) => {
      const state = useAppStore.getState()
      if (
        waitForCreate &&
        settlement.kind === 'structured' &&
        state.activeWorktreeId !== worktreeId &&
        state.activeWorktreeId === selection.activeWorktreeId &&
        state.activeWorkspaceExecutionHostId === selection.activeWorkspaceExecutionHostId &&
        state.activeView === selection.activeView &&
        state.worktreeNavHistory === selection.worktreeNavHistory &&
        state.worktreeNavHistoryIndex === selection.worktreeNavHistoryIndex &&
        resolveWebSessionVisibleTabId(state, selection.activeWorktreeId ?? '') ===
          resolveWebSessionVisibleTabId(selection, selection.activeWorktreeId ?? '')
      ) {
        activateAiVaultResumeWorkspace(worktreeId)
      }
      const handled = replacing?.onSettled(settlement) === true
      if (settlement.kind === 'failed' && !settlement.notified && !handled) {
        notifyAiVaultSessionResumeInChatFailure(settlement.error, rowAgent)
      }
    })
  } catch (error) {
    notifyAiVaultSessionResumeInChatFailure(error, rowAgent)
    replacing?.onSettled(null)
  }
}

/** The first chat the worktree's host does not refuse to take the row over, trying them in order.
 *  A host that cannot answer yet keeps the chat it was asked about, whose own launch reports it. */
export async function adoptingAgentOnHost(
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
  const failure = structuredLaunchFailure(error)
  if (
    hasRuntimeRpcErrorCode(error, 'agent_session_conflict') ||
    failure?.code === 'agent_session_conflict'
  ) {
    toast.error(
      failure?.details?.reason === 'conversationHeldElsewhere' && !failure.owner
        ? cliConversationExitGuidance(rowAgent)
        : translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
    )
    return
  }
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
