import { useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { botRefKey, isSameBot, ownBotHost } from '@/lib/bot-hosts'
import { readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { Bot } from '../../../../shared/bot-types'
import { useTranslate } from '@/i18n/use-translate'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import {
  botClientMentionToken,
  botMentionToken,
  botMentionTokens
} from '../../../../shared/bots/bot-mention-context'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../shared/agent-session/identity/orca-session-address-prefix'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { usePairedServerClientInstallation } from './use-paired-server-client-mentions'
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
  selfChats = false,
  /** The chat's session: sending a message that names an agent here in a paired server's chat
   *  introduces it to that chat. */
  sessionId: string | null = null
): NativeChatBotChatRoom | undefined {
  const t = useTranslate()
  const self = useBotForWorkspace(workspaceId ?? null)
  const bots = useBots(useBotsEnabled() && workspaceId !== undefined && hostId !== null)
  // On a paired server whose agents can message agents here: this computer's bots list after its own.
  const clientInstallation = usePairedServerClientInstallation(hostId)
  const listed = useMemo(() => {
    const here = bots.filter((bot) => bot.hostId === hostId)
    const own = self ? here.find((bot) => isSameBot(bot, self)) : undefined
    const others = here.filter((bot) => bot !== own)
    const first = [...(own && selfChats ? [own] : []), ...others]
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      return [...first, ...bots.filter(isOnPairedServer)]
    }
    return clientInstallation ? [...first, ...bots.filter(isOnThisComputer)] : first
  }, [bots, self, hostId, selfChats, clientInstallation])
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
          recentKey: botRefKey(bot),
          icon: <BotAvatar bot={bot} className="size-5 shrink-0" />,
          ...(detail ? { detail } : {}),
          ...(elsewhere
            ? {
                host: (
                  <BotMentionHostBadge
                    label={
                      isOnThisComputer(bot)
                        ? t('bots.groups.thisComputer', 'This computer')
                        : hostLabels.get(bot.hostId)
                    }
                    inline
                    offline={!live.includes(bot.hostId)}
                  />
                )
              }
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
        if (bot.hostId === hostId) {
          return botMentionToken(bot)
        }
        const server = hostId ? botMentionServer(hostId) : null
        if (clientInstallation && server && sessionId && isOnThisComputer(bot)) {
          return botClientMentionToken(bot, clientInstallation)
        }
        return botMentionToken(bot, undefined, botMentionServer(bot.hostId) ?? undefined)
      },
      // Sent, not picked: a draft deleted unsent introduces no one.
      sent: (text: string) => {
        const server = hostId ? botMentionServer(hostId) : null
        if (!clientInstallation || !server || !sessionId) {
          return
        }
        for (const mention of botMentionTokens(text)) {
          const bot = listed.find((entry) => entry.id === mention.id && isOnThisComputer(entry))
          if (bot && mention.client === clientInstallation) {
            introduceToServerChat(server, sessionId, bot.id)
          }
        }
      },
      placeholder: t(
        'bots.chat.mentionPlaceholder',
        'Ask anything, @ to mention bots or files, / for commands'
      )
    }
  }, [listed, purposes, self, hostId, live, hostLabels, t, clientInstallation, sessionId])
}

const isOnPairedServer = (bot: Bot): boolean => botMentionServer(bot.hostId) !== null
const isOnThisComputer = (bot: Bot): boolean => bot.hostId === LOCAL_EXECUTION_HOST_ID

/** Sending a message that names an agent here in a paired server's chat lets that chat's agents ask
 *  it, each ask still waiting on a person's answer; recorded on this computer only. */
function introduceToServerChat(environmentId: string, sessionId: string, botId: string): void {
  callRuntimeRpc(ownBotHost().target, 'pairedServerAsks.introduce', {
    environmentId,
    rootSession: `${ORCA_SESSION_ADDRESS_PREFIX}${sessionId}`,
    botId
  }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
}

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
  return (
    <BotWorkspaceChatRoom
      workspaceId={workspaceId ?? undefined}
      hostId={hostId}
      sessionId={sessionId ?? null}
    >
      {children}
    </BotWorkspaceChatRoom>
  )
}

/** A bot's chat's `@` room for what writes to that chat from outside it, such as an item's comment
 *  box: the bot's workspace and host stand in for the chat tab's. */
export function BotWorkspaceChatRoom({
  workspaceId,
  hostId,
  sessionId,
  children
}: {
  workspaceId: string | undefined
  hostId: ExecutionHostId | null
  /** The chat's session, as which its bots' chats are read; null reads them as the owner. */
  sessionId: string | null
  children: ReactNode
}): React.JSX.Element {
  const self = useBotForWorkspace(workspaceId ?? null)
  const bots = useBots(useBotsEnabled() && hostId !== null)
  const hostBots = useMemo(() => bots.filter((bot) => bot.hostId === hostId), [bots, hostId])
  const ownBot = (self && hostBots.find((bot) => isSameBot(bot, self))) || null
  const picker = useBotChatPicker(hostId, hostBots, ownBot, sessionId)
  const room = useBotChatComposerRoom(
    workspaceId ?? undefined,
    hostId,
    picker.selfId !== null,
    sessionId
  )
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
