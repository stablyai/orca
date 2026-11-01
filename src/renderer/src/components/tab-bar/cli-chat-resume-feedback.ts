import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { agentSessionWriteFailureText } from '../native-chat/agent-session-write-notice-text'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
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

export async function reportCliChatResumeFailure(
  source: CliChatResumeSource,
  error: unknown,
  openOwner: boolean,
  target: RuntimeClientTarget,
  closed = false,
  closing = false
): Promise<void> {
  const refusal = structuredLaunchFailure(error)
  const values = { agent: agentLabel(source.agent) }
  if (closed) {
    const held =
      refusal?.code === 'agent_session_conflict' ||
      refusal?.code === 'agent_session_ownership_unknown'
    if (held && openOwner && refusal?.owner) {
      await reportCliChatResumeOwner(refusal.owner, openOwner, target)
      return
    }
    const reason = refusal?.details?.reason
    // Another terminal still runs it; Session History refuses too until that one stops.
    if (
      refusal?.code === 'agent_session_conflict' &&
      reason === 'conversationHeldElsewhere' &&
      !refusal.owner
    ) {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.otherTerminalAfterClose',
          "{{agent}}'s terminal was closed, but {{agent}} is running this conversation in another terminal. Quit it there or close that terminal, then open the conversation from Session History.",
          values
        )
      )
      return
    }
    // Nothing was written yet, so Session History has nothing to offer.
    if (reason === 'transcriptNotFound') {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedAfterClose',
          "{{agent}}'s terminal was closed, but {{agent}} hadn't saved this conversation yet, so it can't continue in chat. Start a new chat instead.",
          values
        )
      )
      return
    }
    const plainReason =
      reason === 'transcriptUnreadable'
        ? translate(
            'components.native-chat.resumeInNewChat.historyUnavailable',
            "Orca couldn't read the conversation"
          )
        : held
          ? translate(
              'components.native-chat.resumeInNewChat.chatHeld',
              'another chat or terminal is using it'
            )
          : null
    toast.error(
      plainReason
        ? translate(
            'components.native-chat.resumeInNewChat.startFailedAfterClose',
            "{{agent}}'s terminal was closed, but the chat couldn't open: {{reason}}. Your conversation is saved. Open it from Session History.",
            { ...values, reason: plainReason }
          )
        : translate(
            'components.native-chat.resumeInNewChat.chatFailedAfterClose',
            "{{agent}}'s terminal was closed, but the chat couldn't open. Your conversation is saved. Open it from Session History.",
            values
          )
    )
    return
  }
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
  const row = useAppStore.getState().agentStatusByPaneKey[source.paneKey]
  const inThisTerminal = !!row && row.providerSession?.id === source.providerSessionId
  if (
    refusal?.code === 'agent_session_conflict' ||
    refusal?.code === 'agent_session_ownership_unknown'
  ) {
    const owner = refusal.owner
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
