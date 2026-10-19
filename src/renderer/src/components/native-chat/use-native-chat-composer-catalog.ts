import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from '../../../../shared/native-chat-agent-profiles'
import {
  sessionReportedSkills,
  sessionSlashCommandSuggestions,
  type NativeChatSessionSkill,
  type SlashCommandSuggestion
} from '../../../../shared/native-chat-slash-commands'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'
import { withNativeChatResumeCommand } from './use-native-chat-resume-command'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
}

/**
 * What the `/` menu offers. A structured session reports the surface it actually
 * loaded — the only list that includes this repo's own commands and the skills
 * that reach the session through plugin roots — so it wins whenever it is
 * present. The curated per-agent catalog remains the answer for the PTY lane and
 * for a host that predates the report. A structured chat adds Orca's `/resume`.
 */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  const keepsScannedSkills = getNativeChatAgentProfile(agent)?.keepsScannedSkills === true
  const agentCommands = useMemo(() => {
    if (!structured) {
      return getVerifiedNativeChatCommands(agent)
    }
    return withNativeChatResumeCommand(
      reported === undefined
        ? structuredSlashCommands(conversationCommands, agent)
        : sessionSlashCommandSuggestions(agent, reported)
    )
  }, [agent, conversationCommands, reported, structured])
  const sessionSkills = useMemo(
    () =>
      reported !== undefined && !keepsScannedSkills ? sessionReportedSkills(reported) : undefined,
    [keepsScannedSkills, reported]
  )
  return { agentCommands, sessionSkills }
}
