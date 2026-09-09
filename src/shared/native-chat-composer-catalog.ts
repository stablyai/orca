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
  const commands = catalog.agentCommands
  const reportedSkills = (catalog.sessionSkillNames ?? [])
    .filter((name) => !commands.some((command) => command.name === name))
    .map((name) => ({ name }))
  const known = new Set([...commands, ...reportedSkills].map((entry) => entry.name))
  // Discovery can list one skill through several roots; keep one row per name,
  // preferring the root that carried a description.
  const byName = new Map<string, SlashCommandSuggestion>()
  for (const entry of discovered ?? []) {
    if (known.has(entry.name)) {
      continue
    }
    const existing = byName.get(entry.name)
    if (!existing || (!existing.description && entry.description)) {
      byName.set(entry.name, entry)
    }
  }
  return [...commands, ...reportedSkills, ...byName.values()]
}
