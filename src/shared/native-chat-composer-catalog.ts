// What the native-chat `/` menu offers, as one pure selection over the curated
// catalogs and the structured session's own report. The desktop and mobile
// composer hooks are thin membranes over this so the two clients cannot drift.

import type { AgentType } from './agent-status-types'
import type { AgentSessionConversationCommand } from './agent-session-conversation-command'
import type { AgentSessionSlashCommand } from './agent-session-wire'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'
import {
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from './native-chat-slash-commands'
import { structuredSlashCommands } from './structured-agent-session-composer'

export type NativeChatComposerCatalogSource = {
  /** The structured session's self-reported command surface; undefined while
   *  the host predates the report (and until the first report arrives). */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  conversationCommands?: readonly AgentSessionConversationCommand[]
}

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkillNames: readonly string[] | undefined
}

/** A structured session reports the surface it actually loaded — the only list
 *  that includes this repo's own commands and the skills that reach the session
 *  through plugin roots — so it wins whenever it is present. The curated
 *  per-agent catalog remains the answer for the PTY lane and for a host that
 *  predates the report. */
export function nativeChatComposerCatalog(
  agent: AgentType,
  source?: NativeChatComposerCatalogSource
): NativeChatComposerCatalog {
  const reported = source?.sessionCommands
  if (reported !== undefined) {
    return {
      agentCommands: sessionSlashCommandSuggestions(agent, reported),
      sessionSkillNames: sessionReportedSkillNames(reported)
    }
  }
  if (!source) {
    return { agentCommands: getVerifiedNativeChatCommands(agent), sessionSkillNames: undefined }
  }
  return {
    agentCommands: structuredSlashCommands(source.conversationCommands, agent),
    sessionSkillNames: undefined
  }
}

/** The mobile `/` menu renders one ranked list: commands first, then the
 *  reported skills (deduped against command names — a collision keeps the
 *  command and its curated description), then filesystem-discovered skills
 *  (deduped the same way), under one shared cap. Desktop does not use this:
 *  it renders skills in the picker's own group instead. */
export function mobileComposerSlashEntries(
  catalog: NativeChatComposerCatalog,
  discovered?: readonly SlashCommandSuggestion[]
): readonly SlashCommandSuggestion[] {
  // Discovery can list one skill through several roots; keep one row per name,
  // preferring the root that carried a description.
  const discoveredByName = new Map<string, SlashCommandSuggestion>()
  for (const entry of discovered ?? []) {
    const existing = discoveredByName.get(entry.name)
    if (!existing || (!existing.description && entry.description)) {
      discoveredByName.set(entry.name, entry)
    }
  }
  // Desktop parity: the report is the authority on which names exist, but the
  // disk scan stays the source of description — a reported skill keeps its
  // discovered description when one is on disk.
  const reportedSkillNames = new Set(
    (catalog.sessionSkillNames ?? []).filter(
      (name) =>
        !catalog.agentCommands.some((command) => command.name === name && !command.kindUnspecified)
    )
  )
  const reportedSkills = [...reportedSkillNames].map(
    (name) => discoveredByName.get(name) ?? { name }
  )
  // Desktop parity: an unclassified reported command that names a skill joins
  // the skill row (the skill carries the tag and description), not the
  // command list.
  const skillNames = new Set([...reportedSkillNames, ...discoveredByName.keys()])
  const resolvedCommands = catalog.agentCommands.filter(
    (command) => !command.kindUnspecified || !skillNames.has(command.name)
  )
  const commandNames = new Set(resolvedCommands.map((command) => command.name))
  const discoveredSkills = [...discoveredByName.values()].filter(
    (entry) => !reportedSkillNames.has(entry.name) && !commandNames.has(entry.name)
  )
  return [...resolvedCommands, ...reportedSkills, ...discoveredSkills]
}
