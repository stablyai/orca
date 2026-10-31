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
  stopped = false
): Promise<void> {
  const refusal = structuredLaunchFailure(error)
  const values = { agent: agentLabel(source.agent) }
  const stopReason = refusal?.details?.reason
  const stopMessages: Record<string, string> = {
    agentPaused:
      '{{agent}} is paused in this terminal. Resume it there with fg or quit it, then try again.',
    conversationMoved: '{{agent}} moved to a different conversation in this terminal. Try again.',
    agentAmbiguous:
      'Another agent is also running in this terminal with {{agent}}. Quit it, then try again.',
    shellReplaced:
      "{{agent}} replaced this terminal's shell, so stopping it would close the terminal. Quit {{agent}} there, then try again.",
    writerTopologyUnproven:
      "Orca can't confirm {{agent}} is owned by this terminal. Quit {{agent}} and any shared server it uses, then try again.",
    ownerUnproven:
      "Orca couldn't confirm {{agent}} stopped in this terminal. Check the terminal, then try again."
  }
  if (stopReason && stopMessages[stopReason]) {
    toast.error(
      translate(
        `components.native-chat.resumeInNewChat.${stopReason}`,
        stopMessages[stopReason],
        values
      )
    )
    return
  }
  if (stopped) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.startFailedAfterStop',
        "{{agent}} was stopped, but the chat couldn't start. Check the agent's installation and sign-in, then try Continue in Chat UI again.",
        values
      )
    )
    return
  }
  const row = useAppStore.getState().agentStatusByPaneKey[source.paneKey]
  const inThisTerminal =
    !!row && !row.agentPresence?.ended && row.providerSession?.id === source.providerSessionId
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
