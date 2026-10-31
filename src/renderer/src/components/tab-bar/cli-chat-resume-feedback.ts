import { toast } from 'sonner'
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
  target: RuntimeClientTarget
): Promise<void> {
  const refusal = structuredLaunchFailure(error)
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
        ? cliConversationExitGuidance(source.agent, true)
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
    toast.error(cliConversationExitGuidance(source.agent, true))
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
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}
