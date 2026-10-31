import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import type {
  NativeChatSessionSkill,
  SlashCommandSuggestion
} from '../../../../shared/native-chat/input/native-chat-slash-commands'
import { nativeChatSessionSkills } from '../../../../shared/native-chat-skill-visibility'
import { structuredSessionSlashCommands } from '../../../../shared/structured-agent-session-composer'
import { translate } from '@/i18n/i18n'
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
  const hostSetsGoals = structuredTransport?.threadGoal !== undefined
  const agentCommands = useMemo(() => {
    if (!structured) {
      return getVerifiedNativeChatCommands(agent)
    }
    const commands = structuredSessionSlashCommands(agent, conversationCommands, reported)
    return withNativeChatResumeCommand(
      hostSetsGoals && !commands.some(({ name }) => name === 'goal')
        ? [
            ...commands,
            {
              name: 'goal',
              description: translate(
                'components.native-chat.slashCommandDescriptions.goal',
                'Set or view the goal'
              )
            }
          ]
        : commands
    )
  }, [agent, conversationCommands, reported, structured, hostSetsGoals])
  const sessionSkills = useMemo(() => nativeChatSessionSkills(agent, reported), [agent, reported])
  return { agentCommands, sessionSkills }
}
