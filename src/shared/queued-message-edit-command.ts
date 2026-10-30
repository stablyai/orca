import type { AgentType } from './agent-status-types'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import {
  prepareStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from './structured-agent-session-composer'

/** Provider prompt commands remain content; host actions cannot replace a queued body. */
export function queuedMessageEditAcceptsText(
  text: string,
  agent: AgentType,
  reported?: readonly AgentSessionSlashCommand[],
  hostSetsGoals = false
): boolean {
  return prepareQueuedMessageEditText(agent, reported, hostSetsGoals)(text)
}

export function prepareQueuedMessageEditText(
  agent: AgentType,
  reported?: readonly AgentSessionSlashCommand[],
  hostSetsGoals = false
): (text: string) => boolean {
  const hostCommand = prepareStructuredAgentSessionComposerCommand(agent, reported)
  return (text) =>
    !(
      hostCommand(text) ||
      (hostSetsGoals && isStructuredAgentSessionGoalCommand(text)) ||
      /^\/resume(?:\s|$)/i.test(text)
    )
}
