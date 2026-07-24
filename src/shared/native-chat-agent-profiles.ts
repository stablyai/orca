import type { AgentType } from './agent-status-types'
import { NATIVE_CHAT_AGENT_ADAPTERS } from './native-chat-agent-adapters'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

export type NativeChatAgentProfile = Readonly<{
  skillPrefix: '$' | '/'
  groupedSlash: boolean
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
}>

/**
 * Returns the adapter-backed skill profile with stable reference identity for React consumers.
 */
export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return NATIVE_CHAT_AGENT_ADAPTERS.get(agent)
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return NATIVE_CHAT_AGENT_ADAPTERS.get(agent)?.commandCatalog === 'agent'
    ? getAgentSlashCommands(agent)
    : []
}
