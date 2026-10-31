import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from '@/lib/structured-agent-session-launch-failure'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { agentSessionWriteFailureText } from '../native-chat/agent-session-write-notice-text'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cliConversationExitGuidance } from '@/lib/cli-conversation-exit-guidance'
import type { CliChatResumeSource } from './cli-chat-resume-source'

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
    const reason = refusal?.details?.reason
    const plainReason =
      reason === 'transcriptNotFound' || reason === 'transcriptUnreadable'
        ? translate(
            'components.native-chat.resumeInNewChat.historyUnavailable',
            "Orca couldn't read the conversation"
          )
        : refusal?.code === 'agent_session_conflict' ||
            refusal?.code === 'agent_session_ownership_unknown'
          ? translate(
              'components.native-chat.resumeInNewChat.chatHeld',
              'another chat or terminal is using it'
            )
          : translate(
              'components.native-chat.resumeInNewChat.checkInstallation',
              "check the agent's installation and sign-in"
            )
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.startFailedAfterClose',
        "{{agent}}'s terminal was closed, but the chat couldn't open: {{reason}}. Your conversation is saved. Open it from Session History.",
        { ...values, reason: plainReason }
      )
    )
    return
  }
  if (closing) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.terminalExitUnproven',
        "Orca couldn't confirm {{agent}}'s terminal closed. Check the terminal and host connection before trying again.",
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
    if (openOwner && owner) {
      await activateAiVaultStructuredSession({ structuredSession: owner }, undefined, target)
      return
    }
    toast.error(
      refusal.code === 'agent_session_conflict' &&
        refusal.details?.reason === 'conversationHeldElsewhere' &&
        !owner
        ? cliConversationExitGuidance(source.agent, inThisTerminal)
        : translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeInChatConflict',
            'Another chat is already holding this conversation.'
          )
    )
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
