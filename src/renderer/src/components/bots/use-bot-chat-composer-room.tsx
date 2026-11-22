import { useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { botRefKey, isSameBot } from '@/lib/bot-hosts'
import { readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../shared/bot-types'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import { botMentionToken } from '../../../../shared/bots/bot-mention-context'
import {
  NativeChatBotChatTitleContext,
  NativeChatMentionEveryoneContext,
  NativeChatMentionNamesContext
} from '../native-chat/native-chat-markdown-mentions'
import { useBotChatMentionTitle } from './BotChatMentionTitle'
import { useNativeChatTabOwnerWorktreeId } from '../native-chat/pane/ownership/use-native-chat-tab-owner'
import {
  NativeChatBotChatPickerContext,
  NativeChatBotChatRoomContext,
  NativeChatBotMentionTargetContext,
  type NativeChatBotChatRoom
} from '../native-chat/native-chat-room-context'
import { useBotChatPicker } from './use-bot-chat-picker'
import { NativeChatVisualOwnerContext } from '../native-chat/media/visuals/native-chat-visual-owner'
import { useBotForWorkspace } from './bot-workspace'
import { BotAvatar } from './BotAvatar'
import { refreshBotPurposes, useKnownBotPurposes } from './use-bot-purposes'
import { useBotMentionTargets } from './use-bot-mention-targets'
import { BotMentionHostBadge } from './BotMentionHostBadge'
import { useBotHostLabels } from './use-bot-host-label'
import { botMentionServer } from './bot-mention-server'

/** `@` lists the owner's bots above files, each with what it is for, sent as `[Bot: <name>](bot:<id>)`
 *  so the host tells the agent how to ask them; in a bot's own chat that bot comes first, for its other
 *  chats, where chats can be picked. A chat on this computer lists its paired servers' bots too, after
 *  its own, with the server's pill, named `(bot:<id>@<server>)`, which this computer reaches with
 *  `--on`; a server that is down dims its bots in place. A chat on a server lists only that server's.
 *  Paused bots show but can't be picked. */
export function useBotChatComposerRoom(
  workspaceId: string | undefined,
  hostId: ExecutionHostId | null,
  /** Where the chat's host reads chat picks, its bot's own chats list under it. */
  selfChats = false
): NativeChatBotChatRoom | undefined {
  const t = useTranslate()
  const self = useBotForWorkspace(workspaceId ?? null)
  const bots = useBots(useBotsEnabled() && workspaceId !== undefined && hostId !== null)
  const listed = useMemo(() => {
    const here = bots.filter((bot) => bot.hostId === hostId)
    const own = self ? here.find((bot) => isSameBot(bot, self)) : undefined
    const others = here.filter((bot) => bot !== own)
    const first = [...(own && selfChats ? [own] : []), ...others]
    return hostId === LOCAL_EXECUTION_HOST_ID ? [...first, ...bots.filter(isOnPairedServer)] : first
  }, [bots, self, hostId, selfChats])
  const live = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds, readLiveBotHostIds)
  const hostLabels = useBotHostLabels(
    listed.flatMap((bot) => (bot.hostId === hostId ? [] : [bot.hostId]))
  )
  // What each is for is read once for every chat, and only when someone opens `@`.
  const purposes = useKnownBotPurposes()
  return useMemo(() => {
    if (listed.length === 0) {
      return undefined
    }
    return {
      withFiles: true,
      opened: refreshBotPurposes,
      mentions: listed.map((bot) => {
        const own = self !== null && isSameBot(bot, self)
        const detail = own ? undefined : purposes.get(botRefKey(bot))
        const elsewhere = bot.hostId !== hostId
        return {
          name: bot.name,
          // Keyed by bot and computer, so same-named bots on two computers both list.
          key: botRefKey(bot),
          id: bot.id,
          icon: <BotAvatar bot={bot} className="size-5 shrink-0" />,
          ...(detail ? { detail } : {}),
          ...(elsewhere
            ? { host: <BotMentionHostBadge label={hostLabels.get(bot.hostId)} /> }
            : {}),
          ...(elsewhere && !live.includes(bot.hostId) ? { dimmed: true as const } : {}),
          ...(own ? { note: t('bots.chat.mentionOwnChats', 'Your other chats') } : {}),
          ...(bot.paused ? { unavailable: t('bots.chat.mentionPaused', 'Paused') } : {})
        }
      }),
      // Every chat, a bot's own too, names a picked bot by id, so one rule covers them all.
      token: (value: string) => {
        const bot = listed.find((entry) => botRefKey(entry) === value)
        if (!bot) {
          return undefined
        }
        return bot.hostId === hostId
          ? botMentionToken(bot)
          : botMentionToken(bot, undefined, botMentionServer(bot.hostId) ?? undefined)
      },
      placeholder: t(
        'bots.chat.mentionPlaceholder',
        'Ask anything, @ to mention bots or files, / for commands'
      )
    }
  }, [listed, purposes, self, hostId, live, hostLabels, t])
}

const isOnPairedServer = (bot: Bot): boolean => botMentionServer(bot.hostId) !== null

/** `@` lists the owner's bots, which render as chips, as in a group room. */
export function BotChatRoom({
  tabId,
  sessionId,
  children
}: {
  tabId: string
  /** The chat's session, as which its bots' chats are read (the chat itself is never listed). */
  sessionId?: string
  children: ReactNode
}): React.JSX.Element {
  const workspaceId = useNativeChatTabOwnerWorktreeId(tabId)
  // The visual owner names the host the chat's agent runs on; only that host's bots can be asked.
  const target = useContext(NativeChatVisualOwnerContext)?.target
  const hostId = target ? getRuntimeTargetHostId(target) : null
  const self = useBotForWorkspace(workspaceId ?? null)
  const bots = useBots(useBotsEnabled() && hostId !== null)
  const hostBots = useMemo(() => bots.filter((bot) => bot.hostId === hostId), [bots, hostId])
  const ownBot = (self && hostBots.find((bot) => isSameBot(bot, self))) || null
  const picker = useBotChatPicker(hostId, hostBots, ownBot, sessionId ?? null)
  const room = useBotChatComposerRoom(workspaceId ?? undefined, hostId, picker.selfId !== null)
  // Bots a draft names show as they are now, room or not: deleted, paused or renamed.
  const mentionTargets = useBotMentionTargets(hostId)
  const chatTitle = useBotChatMentionTitle(hostId)
  // Keyed by the names so transcript markdown keeps its extension across polls.
  const key = room?.mentions.map((mention) => mention.name).join('\n') ?? ''
  const names = useMemo(() => (key ? key.split('\n') : null), [key])
  // No group here, so `@everyone` is plain text.
  return (
    <NativeChatMentionEveryoneContext.Provider value={false}>
      <NativeChatMentionNamesContext.Provider value={names}>
        <NativeChatBotChatRoomContext.Provider value={room}>
          <NativeChatBotMentionTargetContext.Provider value={mentionTargets}>
            <NativeChatBotChatPickerContext.Provider value={picker}>
              <NativeChatBotChatTitleContext.Provider value={chatTitle}>
                {children}
              </NativeChatBotChatTitleContext.Provider>
            </NativeChatBotChatPickerContext.Provider>
          </NativeChatBotMentionTargetContext.Provider>
        </NativeChatBotChatRoomContext.Provider>
      </NativeChatMentionNamesContext.Provider>
    </NativeChatMentionEveryoneContext.Provider>
  )
}
