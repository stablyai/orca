import type { AgentType } from './agent-status-types'
import type { SkillDiscoverySource } from './skills'
import {
  getAgentSlashCommands,
  type NativeChatCommandReply,
  type SlashCommandSuggestion
} from './native-chat-slash-commands'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
  /** The agent reports and invokes each skill under this prefix, e.g. Pi's `skill:<name>`. */
  skillNamePrefix?: string
  /** Another agent whose own skill folders, though not its plugins, this agent also reads. */
  readsSkillFoldersOf?: AgentType
  /** OpenCode 1.x reports some skills as commands; 2.x reports none. Keep folder scans for running chats. */
  keepsScannedSkills?: true
  /** The agent's own harness expands a slash command out of the message text, so
   *  the chat host claims only the commands it implements itself. */
  expandsSlashCommandsFromText?: true
  /** Catalog commands the model acts on when they arrive as prose, even though
   *  the runtime has no slash parser of its own. */
  textDrivenCommands?: readonly string[]
}

// Both lines read `.claude/skills` beside their own folders, and 2.x reports no skill as a command.
const OPENCODE_PROFILE: NativeChatAgentProfile = {
  skillPrefix: '/',
  skillSourceOwner: 'opencode',
  readsSkillFoldersOf: 'claude',
  keepsScannedSkills: true,
  expandsSlashCommandsFromText: true
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<AgentType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    skillSourceOwner: 'codex',
    // App-server has no slash parser; the model owns goal tools and receives /goal objectives as prose.
    textDrivenCommands: ['goal']
  },
  claude: {
    skillPrefix: '/',
    skillSourceOwner: 'claude',
    expandsSlashCommandsFromText: true
  },
  openclaude: {
    skillPrefix: '/',
    skillSourceOwner: 'claude',
    expandsSlashCommandsFromText: true
  },
  opencode: OPENCODE_PROFILE,
  opencode2: OPENCODE_PROFILE,
  grok: {
    skillPrefix: '/',
    skillSourceOwner: 'grok'
  },
  // Pi expands only `/skill:<name>`; a bare `/<name>` reaches the model as text.
  pi: {
    skillPrefix: '/',
    skillSourceOwner: 'pi',
    skillNamePrefix: 'skill:'
  }
}

/** Whether skills under `source` reach `profile`'s agent: shared roots, its own, and the skill
 *  folders of an agent it also reads. */
export function readsSkillSource(
  profile: Pick<NativeChatAgentProfile, 'skillSourceOwner' | 'readsSkillFoldersOf'>,
  source: Pick<SkillDiscoverySource, 'owner' | 'sourceKind'>
): boolean {
  return (
    source.owner === null ||
    source.owner === profile.skillSourceOwner ||
    (source.owner === profile.readsSkillFoldersOf && source.sourceKind !== 'plugin')
  )
}

export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** Shared catalog for send/collision/envelope classification; Grok remains skills-only until its command catalog is verified. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' ? [] : getAgentSlashCommands(agent)
}

/** How the chat finds the reply to a verified command over a terminal session;
 *  null when the agent answers it in the terminal or the command is unknown. */
export function getNativeChatCommandReply(
  agent: AgentType,
  commandName: string
): NativeChatCommandReply | null {
  return (
    getVerifiedNativeChatCommands(agent).find((command) => command.name === commandName)?.reply ??
    null
  )
}

/** Exclude desktop-only answers: mobile lacks composer answers/transcript reply rows and would offer commands with no visible result. */
export function getAgentAnsweredNativeChatCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  return getVerifiedNativeChatCommands(agent).filter((command) => command.reply === undefined)
}

/** Offer catalog commands handled by agent message text in the picker as well as accepting typed input. */
export function getTextDrivenNativeChatCommands(
  agent: AgentType | null | undefined
): readonly SlashCommandSuggestion[] {
  if (!agent) {
    return []
  }
  const names = new Set(getNativeChatAgentProfile(agent)?.textDrivenCommands ?? [])
  return names.size === 0
    ? []
    : getVerifiedNativeChatCommands(agent).filter((command) => names.has(command.name))
}

/** Claim catalog commands by default so /clear never becomes literal model input; profiles unclaim only commands the agent handles as text. */
export function getHostClaimedNativeChatCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  const profile = getNativeChatAgentProfile(agent)
  if (profile?.expandsSlashCommandsFromText) {
    return []
  }
  const passedThrough = new Set(profile?.textDrivenCommands ?? [])
  return getVerifiedNativeChatCommands(agent).filter((command) => !passedThrough.has(command.name))
}
