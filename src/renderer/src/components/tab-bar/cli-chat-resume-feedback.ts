import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  structuredLaunchConversationOwner,
  structuredLaunchFailure
} from '@/lib/agent-session/launch/structured-agent-session-launch-failure'
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

/** Said in the chat that took the terminal's place, since that terminal is gone. */
export function cliChatResumeExitUnprovenText(source: CliChatResumeSource): string {
  return translate(
    'components.native-chat.resumeInNewChat.terminalExitUnprovenInChat',
    "Orca closed {{agent}}'s terminal but couldn't confirm {{agent}} stopped. Check the host connection, then try again.",
    { agent: agentLabel(source.agent) }
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
