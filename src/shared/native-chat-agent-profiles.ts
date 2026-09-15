import type { AgentType } from './agent-status-types'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

/** How an agent takes a composer attachment. `image-paste` bracket-pastes the
 *  raw path, which only agents with a verified image-paste gesture turn into an
 *  attachment chip; `file-reference` sends the portable `@path` mention, which
 *  every other agent reads as a file to open rather than as prose. */
export type NativeChatAttachmentForm = 'image-paste' | 'file-reference'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: AgentType
  /** The agent's own harness expands a slash command out of the message text, so
   *  the chat host claims only the commands it implements itself. */
  expandsSlashCommandsFromText?: true
  /** Catalog commands the model acts on when they arrive as prose, even though
   *  the runtime has no slash parser of its own. */
  textDrivenCommands?: readonly string[]
  attachmentForm: NativeChatAttachmentForm
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<AgentType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    skillSourceOwner: 'codex',
    // The app-server has no slash parser, but the model owns goal tools and
    // calls create_goal itself when `/goal <objective>` reaches it as prose.
    textDrivenCommands: ['goal'],
    attachmentForm: 'image-paste'
  },
  claude: {
    skillPrefix: '/',
    skillSourceOwner: 'claude',
    expandsSlashCommandsFromText: true,
    attachmentForm: 'image-paste'
  },
  openclaude: {
    skillPrefix: '/',
    skillSourceOwner: 'claude',
    expandsSlashCommandsFromText: true,
    attachmentForm: 'image-paste'
  },
  grok: {
    skillPrefix: '/',
    skillSourceOwner: 'grok',
    attachmentForm: 'image-paste'
  }
}

export function getNativeChatAgentProfile(
  agent: AgentType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** Attachment form for an agent. Agents without a verified profile fall back to
 *  `@path`: an unverified TUI has no image-paste gesture, so a bracketed raw
 *  path would land in its composer as text the model reads as prose. */
export function getNativeChatAttachmentForm(
  agent: AgentType | null | undefined
): NativeChatAttachmentForm {
  return getNativeChatAgentProfile(agent)?.attachmentForm ?? 'file-reference'
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok has no verified catalog yet, so its slash
 *  surface stays skills-only — this is the single place that policy lives. */
export function getVerifiedNativeChatCommands(agent: AgentType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' ? [] : getAgentSlashCommands(agent)
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
