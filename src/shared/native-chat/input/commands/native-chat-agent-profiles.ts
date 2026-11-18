import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../skills/discovery/skills'
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
  /** Other agents whose own skill folders, though not their plugins, this agent also reads. */
  readsSkillFoldersOf?: readonly AgentType[]
  /** OpenCode 1.x reports some skills as commands; 2.x reports none. Keep folder scans for running chats. */
  keepsScannedSkills?: true
  /** The agent's own harness expands a slash command out of the message text, so
   *  the chat host claims only the commands it implements itself. */
  expandsSlashCommandsFromText?: true
  /** Catalog commands the model acts on when they arrive as prose, even though
   *  the runtime has no slash parser of its own. */
  textDrivenCommands?: readonly string[]
  /** The agent's own /goal resumes a paused goal with `/goal resume`. */
  resumesOwnGoal?: true
}

// Both lines read `.claude/skills` beside their own folders, and 2.x reports no skill as a command.
const OPENCODE_PROFILE: NativeChatAgentProfile = {
  skillPrefix: '/',
  skillSourceOwner: 'opencode',
  readsSkillFoldersOf: ['claude'],
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
  // Cursor's ACP reports skills only once a session starts, so resting chats rely on the scan.
  cursor: {
    skillPrefix: '/',
    skillSourceOwner: 'cursor',
    readsSkillFoldersOf: ['claude', 'codex', 'grok']
  },
  opencode2: OPENCODE_PROFILE,
  // ACP reports built-in commands but no skills; the server never reads Gemini CLI's ~/.gemini/skills.
  antigravity: {
    skillPrefix: '/',
    skillSourceOwner: 'antigravity',
    keepsScannedSkills: true
  },
  grok: {
    skillPrefix: '/',
    skillSourceOwner: 'grok',
    resumesOwnGoal: true
  },
  // Pi expands only `/skill:<name>`; a bare `/<name>` reaches the model as text.
  pi: {
    skillPrefix: '/',
    skillSourceOwner: 'pi',
    skillNamePrefix: 'skill:'
  }
}

/** Whether `skill` under `source` reaches `profile`'s agent: shared roots, its own, and the skill
 *  folders of agents it also reads, without their plugins or the skills they bundle. */
export function readsSkillSource(
  profile: Pick<NativeChatAgentProfile, 'skillSourceOwner' | 'readsSkillFoldersOf'>,
  source: Pick<SkillDiscoverySource, 'owner' | 'sourceKind'>,
  skill: Pick<DiscoveredSkill, 'sourceKind'>
): boolean {
  return (
    source.owner === null ||
    source.owner === profile.skillSourceOwner ||
    (profile.readsSkillFoldersOf?.includes(source.owner) === true &&
      source.sourceKind !== 'plugin' &&
      skill.sourceKind !== 'bundled')
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

/** Whether a bare command sent over a terminal session opens a TUI screen the chat cannot show. */
export function nativeChatCommandOpensTerminal(agent: AgentType, command: string): boolean {
  const text = command.trim()
  return getVerifiedNativeChatCommands(agent).some(
    (entry) => entry.opensInTerminal === true && text === `/${entry.name}`
  )
}

/** Exclude composer answers: mobile has no local answer row, so they would show nothing. Transcript replies render on both. */
export function getAgentAnsweredNativeChatCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  return getVerifiedNativeChatCommands(agent).filter((command) => command.reply !== 'composer')
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
