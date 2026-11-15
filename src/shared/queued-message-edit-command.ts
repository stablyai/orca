import { agentSessionInteractionCommand } from './agent-session/options/permissions/agent-session-interaction-mode'
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
  hostSetsInteractionMode: boolean
): boolean {
  return prepareQueuedMessageEditText(agent, reported, hostSetsGoals, hostSetsInteractionMode)(text)
}

export function prepareQueuedMessageEditText(
  agent: AgentType,
  reported: readonly AgentSessionSlashCommand[] | undefined,
  hostSetsGoals: boolean,
  hostSetsInteractionMode: boolean
): (text: string) => boolean {
  const hostCommand = prepareStructuredAgentSessionComposerCommand(agent, reported)
  return (text) =>
    !(
      hostCommand(text) ||
      (hostSetsInteractionMode && agentSessionInteractionCommand(agent, text) !== null) ||
      (hostSetsGoals && isStructuredAgentSessionGoalCommand(text)) ||
      /^\/resume(?:\s|$)/i.test(text)
    )
}
