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
  /** Another agent whose own skill folders, though not its plugins, this agent also reads. */
  readsSkillFoldersOf?: AgentType
  /** The agent's command report may list some skills among its commands (OpenCode 1.x) or none
   *  (2.x), so a running chat keeps the skill folders' list. */
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
    // The app-server has no slash parser, but the model owns goal tools and
    // calls create_goal itself when `/goal <objective>` reaches it as prose.
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

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok has no verified catalog yet, so its slash
 *  surface stays skills-only — this is the single place that policy lives. */
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

/** The verified catalog minus commands only the desktop chat answers: a surface
 *  without the composer's answers or the transcript's reply rows (mobile) would
 *  offer a command that appears to do nothing. */
export function getAgentAnsweredNativeChatCommands(
  agent: AgentType
): readonly SlashCommandSuggestion[] {
  return getVerifiedNativeChatCommands(agent).filter((command) => command.reply === undefined)
}

/** The mirror of the claimed set: catalog commands this agent acts on when they
 *  arrive as message text. The picker offers these too, so a command the agent
 *  implements is discoverable and not merely typable. */
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

/** Catalog commands the chat host answers itself. Whatever is left over reaches
 *  the agent as ordinary text, which is only correct where the agent implements
 *  the command — so an agent unclaims a command only via the profile above.
 *  Claiming stays the default: it is what stops a hand-typed `/clear` from being
 *  sent to the model as literal prompt text. */
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
