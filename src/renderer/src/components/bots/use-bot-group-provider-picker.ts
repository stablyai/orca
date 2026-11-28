import { botTarget, ownBotHost } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { remoteMemberKey } from '../../../../shared/bots/bot-group-mentions'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { useNativeChatProviderPickerScope } from '../native-chat/composer/controls/native-chat-provider-picker-context'
import { useStructuredAgentSessionActiveProvider } from '../native-chat/session/status/structured-agent-session-status-hooks'
import type { BotGroupSession } from './BotGroupSessionReader'

export function useBotGroupProviderPicker({
  group,
  bots,
  sessions,
  readers,
  recipientId,
  isVisible,
  onError
}: {
  group: BotGroup | undefined
  bots: readonly Bot[]
  sessions: ReadonlyMap<string, BotGroupSession>
  readers: readonly { sessionId: string; agent: string }[]
  recipientId: string | null
  isVisible: boolean
  onError: (message: string) => void
}) {
  const chosenId = group?.members.find((member) => member.botId === recipientId)?.sessionId
  const chosen = chosenId ? sessions.get(chosenId) : undefined
  const localRecipientBot =
    recipientId && group
      ? bots.find((bot) => bot.id === recipientId && bot.hostId === group.hostId)
      : undefined
  const remoteMember =
    recipientId && !localRecipientBot
      ? group?.remoteMembers?.find((member) => remoteMemberKey(member) === recipientId)
      : undefined
  const remoteRecipientBot = remoteMember
    ? bots.find(
        (bot) =>
          bot.id === remoteMember.botId && bot.hostId === `runtime:${remoteMember.environmentId}`
      )
    : undefined
  const recipientBot = localRecipientBot ?? remoteRecipientBot
  const pickerSessionId = chosenId ?? remoteRecipientBot?.chatSessionId ?? ''
  const pickerTarget = recipientBot ? botTarget(recipientBot) : botTarget(group ?? ownBotHost())
  const remoteActiveAgent = useStructuredAgentSessionActiveProvider(
    remoteRecipientBot?.chatSessionId ?? '',
    pickerTarget,
    remoteRecipientBot?.agent ?? 'claude'
  )
  const chosenAgent =
    chosen?.agent ??
    (remoteRecipientBot
      ? remoteActiveAgent
      : readers.find((reader) => reader.sessionId === chosenId)?.agent) ??
    'claude'
  const pickerReady = Boolean(
    recipientBot && pickerSessionId && (chosen || remoteRecipientBot?.chatSessionId)
  )
  const pickerScope = useNativeChatProviderPickerScope(
    {
      sessionId: pickerSessionId,
      target: pickerTarget,
      isVisible: Boolean(isVisible && group && pickerReady)
    },
    recipientBot ? folderWorkspaceKey(recipientBot.folderWorkspaceId) : null,
    pickerReady,
    onError
  )
  return { chosen, chosenAgent, pickerScope }
}
