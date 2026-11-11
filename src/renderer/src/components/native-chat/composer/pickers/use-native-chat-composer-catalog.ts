import { useMemo } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../../../shared/native-chat/native-chat-agent-profiles'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../../../shared/native-chat/input/native-chat-slash-commands'
import { nativeChatSessionSkills } from '../../../../../../shared/native-chat/input/native-chat-skill-visibility'
import { structuredSessionSlashCommands } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import { withNativeChatResumeCommand } from '@/components/native-chat/composer/pickers/use-native-chat-resume-command'
import { withNativeChatSideChatRows } from '@/components/native-chat/composer/pickers/use-native-chat-side-chat-command'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/native-chat-structured-composer-transport'

export type NativeChatComposerCatalog = {
  agentCommands: readonly SlashCommandSuggestion[]
  sessionSkills: readonly NativeChatSessionSkill[] | undefined
}

/** Structured chats use host and session-loaded commands/skills plus Orca /resume and /btw; PTY chats retain curated catalogs. */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  const compactInstructions = structuredTransport?.compactInstructions
  const interactionModeSupported =
    structuredTransport?.optionSnapshot.some((entry) => entry.id === 'interactionMode') === true
  const accountUsage = structuredTransport?.accountUsage !== undefined
  const hooks = structuredTransport?.hooks !== undefined
  const fork = structuredTransport?.fork !== undefined
  const sideChat = structuredTransport?.sideChat !== undefined
  const sideChatNotReady = structuredTransport?.sideChat?.notReadyReason ?? null
  const agentCommands = useMemo(() => {
    if (!structured) {
      return getVerifiedNativeChatCommands(agent)
    }
    const commands = withNativeChatResumeCommand(
      structuredSessionSlashCommands(
        agent,
        conversationCommands,
        reported,
        compactInstructions,
        interactionModeSupported
      ),
      accountUsage,
      fork,
      undefined,
      hooks
    )
    return sideChat ? withNativeChatSideChatRows(commands, sideChatNotReady) : commands
  }, [
    accountUsage,
    hooks,
    agent,
    fork,
    sideChat,
    sideChatNotReady,
    compactInstructions,
    conversationCommands,
    reported,
    structured,
    interactionModeSupported
  ])
  const sessionSkills = useMemo(() => nativeChatSessionSkills(agent, reported), [agent, reported])
  return { agentCommands, sessionSkills }
}
