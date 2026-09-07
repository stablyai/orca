import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import type { AgentType } from './agent-status-types'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import type { AgentSessionConversationCommand } from './agent-session-conversation-command'

const MODEL_COMMAND: SlashCommandSuggestion = {
  name: 'model',
  description: 'Choose the model'
}

const EFFORT_COMMAND: SlashCommandSuggestion = {
  name: 'effort',
  description: 'Choose reasoning effort'
}

const CONVERSATION_COMMANDS: readonly SlashCommandSuggestion[] = [
  { name: 'clear', description: 'Start a fresh conversation' },
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
  conversationCommands?: readonly AgentSessionConversationCommand[]
  runConversationCommand?: (
    command: AgentSessionConversationCommand
  ) => Promise<{ accepted: boolean; error: string | null }>
}

export type StructuredAgentSessionCommandOutcome = {
  handled: boolean
  accepted: boolean
  error: string | null
}

function commandParts(text: string): { name: string; argument: string } | null {
  if (!text.startsWith('/')) {
    return null
  }
  const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(text.trimEnd())
  return match ? { name: match[1]!.toLowerCase(), argument: match[2]?.trim() ?? '' } : null
}

/** The commands the composer menu offers. Strictly what the dispatcher honors,
 *  so a menu pick is never answered with "not available". */
export function structuredSlashCommands(
  commands: readonly AgentSessionConversationCommand[] = []
): readonly SlashCommandSuggestion[] {
  return [
    ...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
    ...CONVERSATION_COMMANDS.filter((entry) =>
      commands.includes(entry.name as AgentSessionConversationCommand)
    )
  ]
}

/** Wider than the offered menu on purpose: a TUI-only command still has to be
 *  claimed here and answered, or a hand-typed `/clear` reaches the model as
 *  literal prompt text. */
function structuredRecognizedCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return [
    ...STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
    ...CONVERSATION_COMMANDS,
    ...getVerifiedNativeChatCommands(agent)
  ]
}

export function isStructuredAgentSessionComposerCommand(
  text: string,
  agent: AgentType = 'codex'
): boolean {
  const command = commandParts(text)
  return Boolean(
    command && structuredRecognizedCommands(agent).some((entry) => entry.name === command.name)
  )
}

function unavailable(name: string): StructuredAgentSessionCommandOutcome {
  return {
    handled: true,
    accepted: true,
    error: `/${name} is not available in chat sessions. Use the slash menu to see available commands.`
  }
}

export async function dispatchStructuredAgentSessionComposerCommand(
  text: string,
  controller: StructuredAgentSessionComposerOptions
): Promise<StructuredAgentSessionCommandOutcome> {
  const command = commandParts(text)
  if (!command || !isStructuredAgentSessionComposerCommand(text, controller.agent)) {
    return { handled: false, accepted: false, error: null }
  }
  if (command.name === 'clear' || command.name === 'compact') {
    if (command.argument) {
      return { handled: true, accepted: false, error: `Use /${command.name} without arguments.` }
    }
    if (
      !controller.conversationCommands?.includes(command.name) ||
      !controller.runConversationCommand
    ) {
      return {
        handled: true,
        accepted: false,
        error: `/${command.name} is not supported by this chat host.`
      }
    }
    return { handled: true, ...(await controller.runConversationCommand(command.name)) }
  }
  if (command.name !== 'model' && command.name !== 'effort') {
    return unavailable(command.name)
  }
  const descriptor = controller.snapshot.find((entry) => entry.id === command.name)
  if (!descriptor || descriptor.kind.type !== 'select') {
    return {
      handled: true,
      accepted: true,
      error: `${command.name === 'model' ? 'Models' : 'Reasoning effort'} are unavailable for this chat session.`
    }
  }
  if (!command.argument) {
    const opened = await controller.invokeAction(command.name)
    return {
      handled: true,
      accepted: opened,
      error: opened ? null : `Could not open the ${command.name} picker.`
    }
  }
  const normalized = command.argument.toLowerCase()
  const choice = descriptor.kind.choices.find(
    (entry) => entry.value.toLowerCase() === normalized || entry.label.toLowerCase() === normalized
  )
  if (!choice) {
    return {
      handled: true,
      accepted: false,
      error: `${command.argument} is not an available ${command.name} for this chat session.`
    }
  }
  const applied = await controller.setOption(command.name, choice.value)
  return {
    handled: true,
    accepted: applied,
    error: applied ? null : `Could not apply ${command.name} ${choice.label}.`
  }
}
