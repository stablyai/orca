import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type { NativeChatAgent } from '../../../agent-launch/permissions/agent-chat-permission-support'
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
  /** Other agents whose project skill folders, but not home ones, this agent also reads. */
  readsProjectSkillFoldersOf?: readonly AgentType[]
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

// Every chat agent is listed so a new one cannot miss its skills; null means no folder scan runs,
// because the agent reports its own skills at rest or cannot invoke them from the chat.
const NATIVE_CHAT_AGENT_PROFILES: Record<NativeChatAgent, NativeChatAgentProfile | null> &
  Partial<Record<AgentType, NativeChatAgentProfile | null>> = {
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
  },
  // Copilot reads Claude's project skills, not its home ones, and reports skills only in a session.
  copilot: {
    skillPrefix: '/',
    skillSourceOwner: 'copilot',
    readsProjectSkillFoldersOf: ['claude']
  },
  // Auggie, built on Pi, expands only `/skill:<name>` and reports no skills; it reads `.claude` too.
  aug: {
    skillPrefix: '/',
    skillSourceOwner: 'aug',
    skillNamePrefix: 'skill:',
    readsSkillFoldersOf: ['claude']
  },
  // Hermes' ACP sends an unregistered `/word` to the model as text, so a picked skill would not load.
  hermes: null,
  // Both report their user and project skills as `skill:<name>`, at rest too.
  kimi: null,
  // Kiro's ACP pushes its own slash commands for each session.
  kiro: null,
  // Goose reports its skills as commands, at rest too.
  goose: null,
  // Orca knows no skill folders of theirs; their sessions report what they load as commands.
  kilo: null,
  'mimo-code': null,
  omp: null,
  // No folder scan until Gemini's ACP is checked to load a picked skill.
  gemini: null,
  // Droid reports skills only once a session starts, so resting chats rely on the scan.
  droid: {
    skillPrefix: '/',
    skillSourceOwner: 'droid'
  },
  // Qwen lists its skills as commands once a session runs; Orca knows none of its skill folders.
  'qwen-code': null,
  // Devin's ACP reports its commands at session start; no skill-folder scan runs for it.
  devin: null
}

/** Whether `skill` under `source` reaches `profile`'s agent: shared roots, its own, and the skill
 *  folders of agents it also reads, without their plugins or the skills they bundle. */
export function readsSkillSource(
  profile: Pick<
    NativeChatAgentProfile,
    'skillSourceOwner' | 'readsSkillFoldersOf' | 'readsProjectSkillFoldersOf'
  >,
  source: Pick<SkillDiscoverySource, 'owner' | 'sourceKind' | 'readers'>,
  skill: Pick<DiscoveredSkill, 'sourceKind'>
): boolean {
  if (source.owner === null) {
    return true
  }
  if (source.owner === profile.skillSourceOwner) {
    return source.readers !== 'borrowers'
  }
  const borrowed =
    profile.readsSkillFoldersOf?.includes(source.owner) === true ||
    (source.sourceKind === 'repo' &&
      profile.readsProjectSkillFoldersOf?.includes(source.owner) === true)
  return (
    borrowed &&
    source.readers !== 'owner' &&
    source.sourceKind !== 'plugin' &&
    skill.sourceKind !== 'bundled'
  )
}

const HOME_SKILL_FOLDER_OWNERS_OTHERS_READ: ReadonlySet<AgentType> = new Set(
  Object.values(NATIVE_CHAT_AGENT_PROFILES).flatMap((profile) => profile?.readsSkillFoldersOf ?? [])
)

/** Whether another agent reads `owner`'s home skill folders, so its default home still matters. */
export function isSkillFolderOwnerOthersRead(owner: AgentType): boolean {
  return HOME_SKILL_FOLDER_OWNERS_OTHERS_READ.has(owner)
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
