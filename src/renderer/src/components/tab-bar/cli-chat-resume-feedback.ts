import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import {
  structuredLaunchConversationOwner,
  structuredLaunchFailure
} from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { agentSessionWriteFailureText } from '../native-chat/messages/notices/agent-session-write-notice-text'
import { agentLabel } from '../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { cliConversationExitGuidance } from '@/lib/agent-session/resume/history/cli-conversation-exit-guidance'
import { retryStructuredAgentSessionLaunch } from '@/lib/agent-session/launch/structured-agent-session-launch'
import { reopenNativeChatCliForkOrigin } from './native-chat-cli-fork-run'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentSessionConversationOwner } from '../../../../shared/agent-session/failures/agent-session-refusal-details'
import type { CliChatResumeSource } from './cli-chat-resume-source'

/** Main's answer to a chat that already holds the conversation: the header opens it, the menu says so. */
export async function reportCliChatResumeOwner(
  owner: AgentSessionConversationOwner | undefined,
  openOwner: boolean,
  target: RuntimeClientTarget
): Promise<void> {
  if (openOwner && owner) {
    await activateAiVaultStructuredSession({ structuredSession: owner }, undefined, target)
    return
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
      'Another chat is already holding this conversation.'
    )
  )
}

export function reportCliChatResumeTerminalChanged(source: CliChatResumeSource): void {
  toast.error(
    translate(
      'components.native-chat.resumeInNewChat.terminalChanged',
      'The terminal running {{agent}} changed before it closed, so Orca left it open. Try again.',
      { agent: agentLabel(source.agent) }
    )
  )
}

/** After the terminal closed, the chat that took its place says why, as any failed start does;
 *  only a chat that already holds the conversation is opened instead. */
export async function reportCliChatResumeFailureInChat(
  error: unknown,
  openOwner: boolean,
  target: RuntimeClientTarget,
  dropChat: () => void
): Promise<void> {
  const owner = structuredLaunchConversationOwner(error)
  if (openOwner && owner) {
    dropChat()
    await reportCliChatResumeOwner(owner, openOwner, target)
  }
}

/** The host found no history to open for the conversation: none saved, or none it can reach. */
function canRestartMissingConversation(error: unknown): boolean {
  const refusal = structuredLaunchFailure(error)
  return (
    refusal?.code === 'agent_session_identity_required' &&
    refusal.details?.reason === 'transcriptNotFound'
  )
}

/** After the terminal closed with no history to open: an unsaved fork of a chat is still that chat's
 *  conversation, so that chat comes back; otherwise the chat that took its place starts a new one. */
export async function recoverMissingConversation(
  error: unknown,
  source: CliChatResumeSource,
  chatTabId: string | null,
  target: RuntimeClientTarget,
  dropChat: () => void
): Promise<boolean> {
  if (!canRestartMissingConversation(error)) {
    return false
  }
  const chatSessionId = (
    useAppStore.getState().unifiedTabsByWorktree[source.workspaceId] ?? []
  ).find((tab) => tab.id === chatTabId)?.entityId
  if (await reopenNativeChatCliForkOrigin(source, chatSessionId, target)) {
    dropChat()
    return true
  }
  return (
    !!chatSessionId &&
    retryStructuredAgentSessionLaunch(source.workspaceId, chatSessionId, { fresh: true })
  )
}

export async function reportCliChatResumeFailure(
  source: CliChatResumeSource,
  error: unknown,
  openOwner: boolean,
  target: RuntimeClientTarget,
  closing = false
): Promise<void> {
  const refusal = structuredLaunchFailure(error)
  const values = { agent: agentLabel(source.agent) }
  if (closing) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.terminalExitUnproven',
        "Orca closed {{agent}}'s terminal but couldn't confirm it stopped, so the chat didn't open. Check the host connection, then open the conversation from Session History.",
        values
      )
    )
    return
  }
  const row = useAppStore.getState().agentStatusByPaneKey.get(source.paneKey)
  const inThisTerminal = !!row && row.providerSession?.id === source.providerSessionId
  if (
    refusal?.code === 'agent_session_conflict' ||
    refusal?.code === 'agent_session_ownership_unknown'
  ) {
    const owner = refusal.owner ?? undefined
    if (
      refusal.code === 'agent_session_conflict' &&
      refusal.details?.reason === 'conversationHeldElsewhere' &&
      !owner
    ) {
      toast.error(cliConversationExitGuidance(source.agent, inThisTerminal))
      return
    }
    await reportCliChatResumeOwner(owner, openOwner, target)
    return
  }
  // The chat's agent refused to start while the terminal may still write the conversation.
  if (
    refusal?.code === 'agent_session_operation_invalid' &&
    refusal.details?.reason === 'conversationOpenInTerminal'
  ) {
    toast.error(cliConversationExitGuidance(source.agent, inThisTerminal))
    return
  }
  if (refusal?.code === 'agent_session_identity_required') {
    if (refusal.details?.reason === 'transcriptNotFound') {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedYet',
          "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
          { agent: agentLabel(source.agent) }
        )
      )
      return
    }
    const failure = structuredLaunchFailure(error)
    if (failure) {
      toast.error(agentSessionWriteFailureText(failure, 'read-history'))
      return
    }
  }
  toast.error(
    translate(
      'components.native-chat.resumeInNewChat.resumeFailed',
      "{{agent}} couldn't continue in chat. Check this terminal and the host connection, then try again.",
      values
    )
  )
}
