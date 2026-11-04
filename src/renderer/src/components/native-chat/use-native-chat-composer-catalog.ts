import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat/native-chat-agent-profiles'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../shared/native-chat/input/native-chat-slash-commands'
import { nativeChatSessionSkills } from '../../../../shared/native-chat/input/native-chat-skill-visibility'
import { structuredSessionSlashCommands } from '../../../../shared/agent-session/view/structured-agent-session-composer'
import { withNativeChatOrcaCommands } from './use-native-chat-orca-commands'
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
  const compactInstructions = structuredTransport?.compactInstructions
  const agentCommands = useMemo(
    () =>
      structured
        ? withNativeChatOrcaCommands(
            structuredSessionSlashCommands(
              agent,
              conversationCommands,
              reported,
              compactInstructions
            ),
            agent
          )
        : getVerifiedNativeChatCommands(agent),
    [agent, compactInstructions, conversationCommands, reported, structured]
  )
  const sessionSkills = useMemo(() => nativeChatSessionSkills(agent, reported), [agent, reported])
  return { agentCommands, sessionSkills }
}
