import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type { AgentSessionConversationCommand } from '../agent-session-conversation-command'
import type { AgentSessionThreadGoalChange } from '../agent-session-thread-goal-wire'
import type { SlashCommandSuggestion } from '../../native-chat/input/native-chat-slash-commands'
/** Session options remain available on hosts predating conversation commands. */
export const STRUCTURED_AGENT_SESSION_SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'model', description: 'Choose the model' },
  { name: 'effort', description: 'Choose reasoning effort' }
]

export const CONVERSATION_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Clear conversation context' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'review', description: 'Review changes', argumentHint: '[instructions]' }
]

export function commandParts(text: string): { name: string; argument: string } | null {
  if (!text.startsWith('/')) {
    return null
  }
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) {
    return null
  }
  const name = match[1]!.toLowerCase()
  const argument = match[2]?.trim() ?? ''
  // Other commands take one line; a longer message that starts with their name is for the agent.
  return /[\n\r\u2028\u2029]/.test(argument) &&
    !CONVERSATION_COMMANDS.some((entry) => entry.name === name)
    ? null
    : { name, argument }
}

export function structuredRecognizedCommands(
  commands?: readonly AgentSessionConversationCommand[],
  clean = false,
  agent?: AgentType
): readonly SlashCommandSuggestion[] {
  return [
    ...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
    ...CONVERSATION_COMMANDS.filter(
      (entry) =>
        entry.name !== 'review' ||
        commands?.includes('review') ||
        (agent === 'codex' && commands === undefined)
    ),
    ...(clean || (agent === 'codex' && commands === undefined)
      ? [{ name: 'stop', description: 'Stop background terminals' }]
      : [])
  ]
}

const GOAL_CONTROLS: ReadonlyMap<string, AgentSessionThreadGoalChange> = new Map([
  ['pause', { kind: 'status', status: 'paused' }],
  ['resume', { kind: 'status', status: 'active' }],
  ['clear', { kind: 'clear' }]
])

/** `/goal pause|resume|clear` controls the current goal; any other text is a new objective. */
export function structuredAgentSessionGoalChange(argument: string): AgentSessionThreadGoalChange {
  return GOAL_CONTROLS.get(argument.toLowerCase()) ?? { kind: 'set', objective: argument }
}

/** `/goal` with nothing after it: an entrance to goal mode, not an objective. */
export function isBareStructuredAgentSessionGoalCommand(text: string): boolean {
  const command = commandParts(text)
  return command?.name === 'goal' && command.argument === ''
}

/** Goal mode strips an optional /goal prefix instead of treating it as objective text. */
export function structuredAgentSessionGoalObjective(text: string): string {
  const goal = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trimEnd())
  return goal ? (goal[1]?.trim() ?? '') : text.trim()
}

/** `/goal …`, which the host answers only where it can set this session's goal. */
export function isStructuredAgentSessionGoalCommand(text: string): boolean {
  return commandParts(text)?.name === 'goal'
}
