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
