import { getTextDrivenNativeChatCommands } from './native-chat-agent-profiles'
import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from './native-chat/input/native-chat-session-options'
import {
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from './native-chat/input/native-chat-slash-commands'
import type { AgentSessionConversationCommand } from './agent-session/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import {
  structuredComposerFailure,
  type StructuredComposerFailureCode,
  type StructuredComposerFailureParams
} from './structured-agent-session-composer-failure'

const MODEL_COMMAND: SlashCommandSuggestion = {
  name: 'model',
  description: 'Choose the model'
}

const EFFORT_COMMAND: SlashCommandSuggestion = {
  name: 'effort',
  description: 'Choose reasoning effort'
}

const CONVERSATION_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Clear conversation context' },
  { name: 'compact', description: 'Compact conversation context' }
]

/** Session options remain available on hosts predating conversation commands. */
export const STRUCTURED_AGENT_SESSION_SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
  MODEL_COMMAND,
  EFFORT_COMMAND
]

export type StructuredAgentSessionComposerOptions = {
  agent?: AgentType
  snapshot: readonly SessionOptionDescriptor[]
  invokeAction: (id: string) => Promise<boolean>
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  /** What the running session reported for its `/` menu; undefined until read or on an older host. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  conversationCommands?: readonly AgentSessionConversationCommand[]
  runConversationCommand?: (
    command: AgentSessionConversationCommand
  ) => Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'>>
  /** Without host goal support, /goal remains agent-handled text. */
  setThreadGoalObjective?: (objective: string) => Promise<boolean>
}

/** Visible condition holding a refusal: agent/prompt/background work, an in-flight send or a Retry card. */
export type StructuredAgentSessionCommandRefusalCause =
  | 'working'
  | 'prompt'
  | 'background'
  | 'sending'
  | 'retry'

export type StructuredAgentSessionCommandOutcome = {
  handled: boolean
  accepted: boolean
  error: string | null
  /** Set on refusals this module words, so a client can translate `error`. */
  errorCode?: StructuredComposerFailureCode
  errorParams?: StructuredComposerFailureParams
  /** Show refusal only while this condition holds. */
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
}

function commandParts(text: string): { name: string; argument: string } | null {
  if (!text.startsWith('/')) {
    return null
  }
  const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(text.trimEnd())
  return match ? { name: match[1]!.toLowerCase(), argument: match[2]?.trim() ?? '' } : null
}

/** Fallback menu combines host-owned and agent text-driven commands when no catalog is reported. */
export function structuredSlashCommands(
  commands: readonly AgentSessionConversationCommand[] = [],
  agent?: AgentType | null
): readonly SlashCommandSuggestion[] {
  const hostOwned = [
    ...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
    ...CONVERSATION_COMMANDS.filter((entry) =>
      commands.includes(entry.name as AgentSessionConversationCommand)
    )
  ]
  // No reported catalog must not hide agent-handled commands such as Codex /goal.
  return [
    ...hostOwned,
    ...getTextDrivenNativeChatCommands(agent).filter(
      (entry) => !hostOwned.some((offered) => offered.name === entry.name)
    )
  ]
}

/** Host commands remain first; reported catalogs add other names. */
export function structuredSessionSlashCommands(
  agent: AgentType,
  conversationCommands: readonly AgentSessionConversationCommand[] | undefined,
  reported: readonly AgentSessionSlashCommand[] | undefined
): readonly SlashCommandSuggestion[] {
  const hostOwned = structuredSlashCommands(conversationCommands, agent)
  if (reported === undefined) {
    return hostOwned
  }
  const offered = new Set(hostOwned.map(({ name }) => name))
  return [
    ...hostOwned,
    ...sessionSlashCommandSuggestions(agent, reported).filter(({ name }) => !offered.has(name))
  ]
}

function structuredRecognizedCommands(): readonly SlashCommandSuggestion[] {
  return [...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS, ...CONVERSATION_COMMANDS]
}

/** Whether the chat host, rather than the agent, owns this command. Callers also
 *  use it to refuse attachments: a host command sends no message, so attachments
 *  would be silently dropped, whereas a pass-through command is a real send. */
export function isStructuredAgentSessionComposerCommand(
  text: string,
  _agent: AgentType = 'codex',
  _reported?: readonly AgentSessionSlashCommand[]
): boolean {
  const command = commandParts(text)
  return Boolean(
    command && structuredRecognizedCommands().some((entry) => entry.name === command.name)
  )
}

/** Host actions send no message; /goal is an action only on hosts that set goals. */
export function isStructuredAgentSessionHostCommand(text: string, hostSetsGoals: boolean): boolean {
  return (
    isStructuredAgentSessionComposerCommand(text) ||
    (hostSetsGoals && isStructuredAgentSessionGoalCommand(text))
  )
}

export function prepareStructuredAgentSessionComposerCommand(
  _agent: AgentType,
  _reported?: readonly AgentSessionSlashCommand[]
): (text: string) => boolean {
  const names = new Set(structuredRecognizedCommands().map((entry) => entry.name))
  return (text) => {
    const command = commandParts(text)
    return command !== null && names.has(command.name)
  }
}

/** `/clear` or `/compact` alone: a conversation command with nothing after it. */
export function isLoneStructuredAgentSessionConversationCommand(text: string): boolean {
  const command = commandParts(text.trim())
  return Boolean(
    command &&
    command.argument === '' &&
    CONVERSATION_COMMANDS.some((entry) => entry.name === command.name)
  )
}

/** `/goal …`, which the host answers only where it can set this session's goal. */
export function isStructuredAgentSessionGoalCommand(text: string): boolean {
  return commandParts(text)?.name === 'goal'
}

/** `/clear`, `/compact` and `/goal …` change the conversation; option and picker commands do not. */
export function structuredAgentSessionCommandChangesConversation(text: string): boolean {
  const command = commandParts(text)
  return (
    command?.name === 'clear' ||
    command?.name === 'compact' ||
    (command?.name === 'goal' && command.argument !== '')
  )
}

/** `/goal` with nothing after it: an entrance to goal mode, not an objective. */
export function isBareStructuredAgentSessionGoalCommand(text: string): boolean {
  const command = commandParts(text)
  return command?.name === 'goal' && command.argument === ''
}

/** Goal mode strips an optional /goal prefix instead of treating it as objective text. */
export function structuredAgentSessionGoalObjective(text: string): string {
  const command = commandParts(text)
  return command?.name === 'goal' ? command.argument : text.trim()
}

function unavailable(name: string): StructuredAgentSessionCommandOutcome {
  return {
    handled: true,
    accepted: true,
    ...structuredComposerFailure('commandUnavailable', { name })
  }
}

export async function dispatchStructuredAgentSessionComposerCommand(
  text: string,
  controller: StructuredAgentSessionComposerOptions
): Promise<StructuredAgentSessionCommandOutcome> {
  const command = commandParts(text)
  if (command?.name === 'goal' && controller.setThreadGoalObjective) {
    if (!command.argument) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('goalObjectiveMissing')
      }
    }
    // A refusal reaches the user through the session's own error surface.
    return {
      handled: true,
      accepted: await controller.setThreadGoalObjective(command.argument),
      error: null
    }
  }
  if (
    !command ||
    !isStructuredAgentSessionComposerCommand(text, controller.agent, controller.sessionCommands)
  ) {
    return { handled: false, accepted: false, error: null }
  }
  if (command.name === 'clear' || command.name === 'compact') {
    if (command.argument) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('commandTakesNoArguments', { name: command.name })
      }
    }
    if (
      !controller.conversationCommands?.includes(command.name) ||
      !controller.runConversationCommand
    ) {
      return {
        handled: true,
        accepted: false,
        ...structuredComposerFailure('commandUnsupportedByHost', { name: command.name })
      }
    }
    return { handled: true, ...(await controller.runConversationCommand(command.name)) }
  }
  if (command.name !== 'model' && command.name !== 'effort') {
    return unavailable(command.name)
  }
  const descriptor = controller.snapshot.find((entry) => entry.id === command.name)
  if (!command.argument) {
    const opened = await controller.invokeAction(command.name)
    return {
      handled: true,
      accepted: opened,
      ...(opened
        ? { error: null }
        : structuredComposerFailure(
            command.name === 'model' ? 'modelPickerFailed' : 'effortPickerFailed'
          ))
    }
  }
  const normalized = command.argument.toLowerCase()
  const choice =
    descriptor?.kind.type === 'select'
      ? descriptor.kind.choices.find(
          (entry) =>
            entry.value.toLowerCase() === normalized || entry.label.toLowerCase() === normalized
        )
      : undefined
  const value = choice?.value ?? command.argument
  const applied = await controller.setOption(command.name, value)
  return {
    handled: true,
    accepted: applied,
    ...(applied
      ? { error: null }
      : structuredComposerFailure(
          command.name === 'model' ? 'modelApplyFailed' : 'effortApplyFailed',
          { value: choice?.label ?? String(value) }
        ))
  }
}
