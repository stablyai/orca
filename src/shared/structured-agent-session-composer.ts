import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import type { AgentType } from './agent-status-types'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'

const EFFORT_COMMAND: SlashCommandSuggestion = {
  name: 'effort',
  description: 'Choose reasoning effort'
}

export const STRUCTURED_AGENT_SESSION_SLASH_COMMANDS: readonly SlashCommandSuggestion[] = [
  ...getVerifiedNativeChatCommands('codex').slice(0, 1),
  EFFORT_COMMAND,
  ...getVerifiedNativeChatCommands('codex').slice(1)
]

export type StructuredAgentSessionComposerOptions = {
  agent?: AgentType
  snapshot: readonly SessionOptionDescriptor[]
  invokeAction: (id: string) => Promise<boolean>
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
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

function structuredSlashCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  if (agent === 'codex') {
    return STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
  }
  return [...getVerifiedNativeChatCommands(agent), EFFORT_COMMAND]
}

export function isStructuredAgentSessionComposerCommand(
  text: string,
  agent: AgentType = 'codex'
): boolean {
  const command = commandParts(text)
  return Boolean(
    command && structuredSlashCommands(agent).some((entry) => entry.name === command.name)
  )
}

function unavailable(name: string): StructuredAgentSessionCommandOutcome {
  return { handled: true, accepted: true, error: `/${name} is not available in chat sessions.` }
}

export async function dispatchStructuredAgentSessionComposerCommand(
  text: string,
  controller: StructuredAgentSessionComposerOptions
): Promise<StructuredAgentSessionCommandOutcome> {
  const command = commandParts(text)
  if (!command || !isStructuredAgentSessionComposerCommand(text, controller.agent)) {
    return { handled: false, accepted: false, error: null }
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
