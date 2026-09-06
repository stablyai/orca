import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

const EMPTY_SKILL_NAMES: readonly string[] = []

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkillNames: readonly string[]
}

/**
 * What the `/` menu offers. A structured session reports the surface it actually
 * loaded — the only list that includes this repo's own commands and the skills
 * that reach the session through plugin roots — so it wins whenever it is
 * present. The curated per-agent catalog remains the answer for the PTY lane and
 * for a host that predates the report.
 */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const reported = structuredTransport?.sessionCommands
  const agentCommands = useMemo(
    () =>
      !structuredTransport
        ? getVerifiedNativeChatCommands(agent)
        : reported?.length
          ? sessionSlashCommandSuggestions(agent, reported)
          : structuredSlashCommands(agent),
    [agent, reported, structuredTransport]
  )
  const sessionSkillNames = useMemo(
    () => (reported?.length ? sessionReportedSkillNames(reported) : EMPTY_SKILL_NAMES),
    [reported]
  )
  return { agentCommands, sessionSkillNames }
}
