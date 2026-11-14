import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import { agentSessionInteractionCommand } from './agent-session/options/agent-session-interaction-mode'
import type { AgentType } from './agent-status/contracts/agent-status-types'
import type { AgentSessionSlashCommand } from './agent-session/agent-session-wire'
import {
  prepareStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from './agent-session/view/structured-agent-session-composer'

/** Provider prompt commands remain content; host actions cannot replace a queued body. */
export function queuedMessageEditAcceptsText(
  text: string,
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[] | undefined,
  hostSetsGoals: boolean,
  hostSetsInteractionMode: boolean,
  conversationCommands?: readonly AgentSessionConversationCommand[],
  cleanBackgroundTerminals = false
): boolean {
  return prepareQueuedMessageEditText(
    agent,
    reported,
    hostSetsGoals,
    hostSetsInteractionMode,
    conversationCommands,
    cleanBackgroundTerminals
  )(text)
}

export function prepareQueuedMessageEditText(
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[] | undefined,
  hostSetsGoals: boolean,
  hostSetsInteractionMode: boolean,
  conversationCommands?: readonly AgentSessionConversationCommand[],
  cleanBackgroundTerminals = false
): (text: string) => boolean {
  const hostCommand = prepareStructuredAgentSessionComposerCommand(
    agent,
    reported,
    conversationCommands,
    cleanBackgroundTerminals
  )
  return (text) =>
    !(
      hostCommand(text) ||
      (hostSetsInteractionMode && agentSessionInteractionCommand(agent, text) !== null) ||
      (hostSetsGoals && isStructuredAgentSessionGoalCommand(text)) ||
      /^\/resume(?:\s|$)/i.test(text)
    )
}
