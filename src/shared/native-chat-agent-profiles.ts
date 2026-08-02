import type { AgentType } from './agent-status-types'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  groupedSlash: boolean
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<AgentType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    groupedSlash: false,
    skillSourceOwner: 'codex'
  },
  claude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  openclaude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  grok: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'grok'
  }
}

export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok has no verified catalog yet, so its slash
 *  surface stays skills-only — this is the single place that policy lives. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' ? [] : getAgentSlashCommands(agent)
}
