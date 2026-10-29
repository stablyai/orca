import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../shared/native-chat/input/native-chat-slash-commands'
import { nativeChatSessionSkills } from '../../../../shared/native-chat-skill-visibility'
import { structuredSessionSlashCommands } from '../../../../shared/structured-agent-session-composer'
import { withNativeChatResumeCommand } from './use-native-chat-resume-command'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
}

/** Structured chats use host and session-loaded commands/skills plus Orca /resume; PTY chats retain curated catalogs. */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  const agentCommands = useMemo(
    () =>
      structured
        ? withNativeChatResumeCommand(
            structuredSessionSlashCommands(agent, conversationCommands, reported)
          )
        : getVerifiedNativeChatCommands(agent),
    [agent, conversationCommands, reported, structured]
  )
  const sessionSkills = useMemo(() => nativeChatSessionSkills(agent, reported), [agent, reported])
  return { agentCommands, sessionSkills }
}
