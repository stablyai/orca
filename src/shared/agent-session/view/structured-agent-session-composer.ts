import { dispatchNativeReviewCommand } from './structured-agent-session-review-command'
import {
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
  CONVERSATION_COMMANDS,
  commandParts,
  structuredRecognizedCommands,
  structuredAgentSessionGoalChange,
  isStructuredAgentSessionGoalCommand
} from './structured-agent-session-command-syntax'
export {
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
  isStructuredAgentSessionGoalCommand,
  structuredAgentSessionGoalChange,
  isBareStructuredAgentSessionGoalCommand,
  structuredAgentSessionGoalObjective
} from './structured-agent-session-command-syntax'
import type { NativeChatReviewRun } from '../../native-chat/input/native-chat-review-menu'
import type { AgentSessionReviewTarget } from '../agent-session-review-target'
import { agentSessionInteractionCommand } from '../options/agent-session-interaction-mode'
import { getTextDrivenNativeChatCommands } from '../../native-chat/native-chat-agent-profiles'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../native-chat/input/native-chat-session-options'
import {
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../../native-chat/input/native-chat-slash-commands'
import type { AgentSessionConversationCommand } from '../agent-session-conversation-command'
import type { AgentSessionThreadGoalChange } from '../agent-session-thread-goal-wire'
import type { AgentSessionSlashCommand } from '../agent-session-wire'
import {
  structuredComposerFailure,
  type StructuredComposerFailureCode,
  type StructuredComposerFailureParams
} from '../failures/structured-agent-session-composer-failure'

const COMPACT_INSTRUCTIONS_HINT = '[instructions]'

export type StructuredAgentSessionComposerOptions = {
  agent?: AgentType
  snapshot: readonly SessionOptionDescriptor[]
  invokeAction: (id: string, review?: NativeChatReviewRun) => Promise<boolean>
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  /** What the running session reported for its `/` menu; undefined until read or on an older host. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  conversationCommands?: readonly AgentSessionConversationCommand[]
  /** Text after `/compact` reaches the agent; without this it is refused, never dropped. */
  compactInstructions?: boolean
  cleanBackgroundTerminals?: boolean
  cleanBackgroundTerminalsCommand?: () => Promise<boolean>
  runConversationCommand?: (
    command: AgentSessionConversationCommand,
    instructions?: string,
    onSent?: () => void,
    review?: AgentSessionReviewTarget
  ) => Promise<Omit<StructuredAgentSessionCommandOutcome, 'handled'>>
  /** Without host goal support, /goal remains agent-handled text. */
  changeThreadGoal?: (change: AgentSessionThreadGoalChange) => Promise<boolean>
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

/** Fallback menu combines host-owned and agent text-driven commands when no catalog is reported. */
export function structuredSlashCommands(
  commands: readonly AgentSessionConversationCommand[] = [],
  agent?: AgentType | null,
  compactInstructions = false
): readonly SlashCommandSuggestion[] {
  const hostOwned = [
    ...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
    ...CONVERSATION_COMMANDS.filter((entry) =>
      commands.includes(entry.name as AgentSessionConversationCommand)
    ).map((entry) =>
      entry.name === 'compact' && compactInstructions
        ? { ...entry, argumentHint: COMPACT_INSTRUCTIONS_HINT }
        : entry
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
  reported: readonly AgentSessionSlashCommand[] | undefined,
  compactInstructions?: boolean,
  interactionModeSupported = false,
  cleanBackgroundTerminals = false
): readonly SlashCommandSuggestion[] {
  const modeCommands: SlashCommandSuggestion[] = interactionModeSupported
    ? [
        { name: 'plan', description: 'Switch to Plan mode', orcaOwned: true },
        ...(agent === 'codex'
          ? [{ name: 'default', description: 'Switch to Build mode', orcaOwned: true as const }]
          : [])
      ]
    : []
  const hostOwned = [
    ...(cleanBackgroundTerminals
      ? [{ name: 'stop', description: 'Stop background terminals' }]
      : []),
    ...modeCommands,
    ...structuredSlashCommands(conversationCommands, agent, compactInstructions).filter(
      ({ name }) => !modeCommands.some((entry) => entry.name === name)
    )
  ]
  if (reported === undefined) {
    return hostOwned
  }
  const offered = new Set(hostOwned.map(({ name }) => name))
  return [
    ...hostOwned,
    ...sessionSlashCommandSuggestions(agent, reported).filter(({ name }) => !offered.has(name))
  ]
}

/** Whether the chat host, rather than the agent, owns this command. Callers also
 *  use it to refuse attachments: a host command sends no message, so attachments
 *  would be silently dropped, whereas a pass-through command is a real send. */
export function isStructuredAgentSessionComposerCommand(
  text: string,
  agent: AgentType | undefined,
  snapshot: readonly SessionOptionDescriptor[],
  commands?: readonly AgentSessionConversationCommand[],
  clean = false
): boolean {
  const command = commandParts(text)
  return Boolean(
    (command &&
      structuredRecognizedCommands(commands, clean, agent).some(
        (entry) => entry.name === command.name
      )) ||
    (agentSessionInteractionCommand(agent ?? '', text) !== null &&
      snapshot.some((entry) => entry.id === 'interactionMode'))
  )
}

/** Host actions send no message; /goal is an action only on hosts that set goals. */
export function isStructuredAgentSessionHostCommand(
  text: string,
  hostSetsGoals: boolean,
  agent: AgentType | undefined,
  snapshot: readonly SessionOptionDescriptor[],
  commands?: readonly AgentSessionConversationCommand[],
  clean = false
): boolean {
  return (
    isStructuredAgentSessionComposerCommand(text, agent, snapshot, commands, clean) ||
    (hostSetsGoals && isStructuredAgentSessionGoalCommand(text))
  )
}

export function prepareStructuredAgentSessionComposerCommand(
  _agent: AgentType,
  _reported?: readonly AgentSessionSlashCommand[],
  commands?: readonly AgentSessionConversationCommand[],
  clean = false
): (text: string) => boolean {
  const names = new Set(
    structuredRecognizedCommands(commands, clean, _agent).map((entry) => entry.name)
  )
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
    CONVERSATION_COMMANDS.some((entry) => entry.name !== 'review' && entry.name === command.name)
  )
}

/** `/clear`, `/compact` and goal changes that start work change the conversation; pausing or clearing a goal does not. */
export function structuredAgentSessionCommandChangesConversation(text: string): boolean {
  const command = commandParts(text)
  if (command?.name === 'goal') {
    const change = command.argument ? structuredAgentSessionGoalChange(command.argument) : null
    return change?.kind === 'set' || (change?.kind === 'status' && change.status === 'active')
  }
  return command?.name === 'clear' || command?.name === 'compact' || command?.name === 'review'
}

export async function dispatchStructuredAgentSessionComposerCommand(
  text: string,
  controller: StructuredAgentSessionComposerOptions,
  /** A conversation command left for the host, so the composer can release its draft. */
  onSent?: () => void
): Promise<StructuredAgentSessionCommandOutcome> {
  const interaction = agentSessionInteractionCommand(controller.agent ?? '', text)
  if (interaction !== null && controller.snapshot.some((entry) => entry.id === 'interactionMode')) {
    return {
      handled: true,
      accepted: await controller.setOption('interactionMode', interaction),
      error: null
    }
  }
  const command = commandParts(text)
  if (command?.name === 'goal' && controller.changeThreadGoal) {
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
      accepted: await controller.changeThreadGoal(
        structuredAgentSessionGoalChange(command.argument)
      ),
      error: null
    }
  }
  if (
    !command ||
    !isStructuredAgentSessionComposerCommand(
      text,
      controller.agent,
      controller.snapshot,
      controller.conversationCommands,
      controller.cleanBackgroundTerminals
    )
  ) {
    return { handled: false, accepted: false, error: null }
  }
  const native = await dispatchNativeReviewCommand(command, controller, onSent)
  if (native) {
    return native
  }
  if (command.name === 'clear' || command.name === 'compact') {
    if (command.argument && !(command.name === 'compact' && controller.compactInstructions)) {
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
    return {
      handled: true,
      ...(await (command.argument
        ? controller.runConversationCommand(command.name, command.argument, onSent)
        : controller.runConversationCommand(command.name, undefined, onSent)))
    }
  }
  if (command.name !== 'model' && command.name !== 'effort') {
    return {
      handled: true,
      accepted: true,
      ...structuredComposerFailure('commandUnavailable', { name: command.name })
    }
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
