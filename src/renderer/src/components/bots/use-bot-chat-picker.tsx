// The `@` list's way into a bot's chats: which bots offer it, the chats one lists (the chats this chat
// can mail now, joined to the Activity panel's rows by id), and whether a picked chat may be sent.
import { useCallback, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { botHostTarget } from '@/lib/bot-hosts'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatRow } from '../../../../shared/bots/bot-chat-row'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { botMentionToken } from '../../../../shared/bots/bot-mention-context'
import { BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type {
  NativeChatBotChatPick,
  NativeChatBotChatPicker,
  NativeChatMentionChat,
  NativeChatMentionChatsView
} from '../native-chat/native-chat-mention-chats'
import { BotAvatar } from './BotAvatar'
import { BotChatStatusSlot } from './BotChatOriginIcon'
import { BotChatLine } from './BotChatTreeGroup'
import { useBotChatMentionTitle } from './BotChatMentionTitle'
import {
  requestBotMentionChats,
  useBotMentionChatsReads,
  useBotMentionChatsWatch,
  type BotMentionChatsRead
} from './bot-mention-chats-read'
import { useBotOwnChatTree } from './use-bot-chat-tree'
import { isBotGroupMemberSession } from '../../../../shared/bots/bot-group'
import { useBotHostLabel } from './use-bot-host-label'

/** Whether the computer the chat's agent runs on reads chat picks; an unknown one doesn't. */
function hostReadsChatPicks(hostId: ExecutionHostId): boolean {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const environmentId = runtimeTargetEnvironmentId(botHostTarget(hostId))
  return (
    environmentId !== null &&
    readCachedRuntimeEnvironmentCapability(environmentId, BOTS_CHAT_MENTIONS_RUNTIME_CAPABILITY) ===
      true
  )
}

/** `bots` are the chat's host's own; `self` is the bot whose chat this is, if any; `caller` is the
 *  chat's session, as which its chats are read. */
export function useBotChatPicker(
  hostId: ExecutionHostId | null,
  bots: readonly Bot[],
  self: Bot | null,
  caller: string | null
): NativeChatBotChatPicker {
  const t = useTranslate()
  const hostLabel = useBotHostLabel(hostId ?? LOCAL_EXECUTION_HOST_ID)
  const [viewing, setViewing] = useState<string | null>(null)
  // Bots the draft's chat pills name: read and kept current for Send's check.
  const [pilled, setPilled] = useState<readonly string[]>([])
  const watch = useCallback((botIds: readonly string[]) => {
    setPilled((current) => (current.join('|') === botIds.join('|') ? current : botIds))
  }, [])
  const reads = useBotMentionChatsReads(caller)
  const capable = hostId !== null && hostReadsChatPicks(hostId)
  const botOf = useCallback((botId: string) => bots.find((bot) => bot.id === botId), [bots])
  const viewed = (viewing && botOf(viewing)) || null
  const watched = useMemo(
    () => bots.filter((bot) => bot.id === viewing || pilled.includes(bot.id)),
    [bots, viewing, pilled]
  )
  useBotMentionChatsWatch(watched, caller)
  const tree = useBotOwnChatTree(viewed)
  const title = useBotChatMentionTitle(hostId)
  const selfId = self && capable ? self.id : null

  const unreachable = useCallback(
    (bot: Bot) =>
      hostLabel
        ? t(
            'bots.chat.mentionChatsUnreachable',
            "Can't check {{name}}'s chats: {{host}} isn't connected.",
            {
              name: bot.name,
              host: hostLabel
            }
          )
        : t('bots.chat.mentionChatsUnreadable', "Can't check {{name}}'s chats.", {
            name: bot.name
          }),
    [hostLabel, t]
  )

  const shown = useMemo((): NativeChatBotChatPicker['shown'] => {
    if (!viewed) {
      return null
    }
    const read = reads(viewed)
    const chats: NativeChatMentionChatsView =
      read === null || read.status === 'loading'
        ? { status: 'loading' }
        : read.status === 'error'
          ? {
              status: 'error',
              message: hostLabel
                ? t(
                    'bots.chat.mentionChatsLoadFailedOn',
                    "Couldn't load chats: {{host}} isn't connected",
                    {
                      host: hostLabel
                    }
                  )
                : t('bots.chat.mentionChatsLoadFailed', "Couldn't load chats")
            }
          : {
              status: 'ready',
              chats: mailableChats(read.rows, tree.chats, viewed, viewed.id === self?.id, t)
            }
    return {
      botId: viewed.id,
      name: viewed.name,
      avatar: <BotAvatar bot={viewed} className="size-4 rounded-sm text-3xs" />,
      chats
    }
  }, [viewed, reads, tree.chats, self, hostLabel, t])

  const pick = useCallback(
    (botId: string, chatId: string): NativeChatBotChatPick => {
      const bot = botOf(botId)
      // A deleted bot's pill says so itself, and no host line names it.
      if (!bot) {
        return { state: 'ok' }
      }
      if (!capable) {
        return {
          state: 'unavailable',
          why: hostLabel
            ? t(
                'bots.chat.mentionChatOlderHost',
                "The Orca on {{host}} can't send to a specific chat yet.",
                {
                  host: hostLabel
                }
              )
            : t(
                'bots.chat.mentionChatOlderHostHere',
                "This Orca can't send to a specific chat yet."
              )
        }
      }
      return chatPick(reads(bot), bot, chatId, unreachable(bot), t, () =>
        requestBotMentionChats(bot, caller)
      )
    },
    [botOf, capable, hostLabel, reads, unreachable, t, caller]
  )

  return useMemo(() => {
    if (!capable || hostId === null) {
      // Pills still say why a pasted chat pick can't go; nothing offers one.
      return {
        offers: () => false,
        selfId: null,
        watch,
        prefetch: () => {},
        view: () => {},
        shown: null,
        retry: () => {},
        token: (botId, chat) => tokenOf(botOf(botId), chat, false),
        pick,
        title
      }
    }
    return {
      offers: (botId) => {
        const bot = botOf(botId)
        return bot !== undefined && !bot.paused
      },
      selfId,
      watch,
      prefetch: (botId) => {
        const bot = botOf(botId)
        if (bot && reads(bot) === null) {
          requestBotMentionChats(bot, caller)
        }
      },
      view: setViewing,
      shown,
      retry: () => {
        if (viewed) {
          requestBotMentionChats(viewed, caller)
        }
      },
      token: (botId, chat) => tokenOf(botOf(botId), chat, botId === selfId),
      pick,
      title
    }
  }, [capable, hostId, botOf, selfId, watch, reads, caller, shown, viewed, pick, title])
}

function tokenOf(bot: Bot | undefined, chat: NativeChatMentionChat | null, self: boolean): string {
  if (!bot) {
    return ''
  }
  // Another bot's Home Chat is the bot alone, so it follows a later Home Chat; the chat's own bot's
  // Home Chat is picked by id, as mail to the bot alone from its Home Chat would be refused.
  return chat && (!chat.plain || self) ? botMentionToken(bot, chat.id) : botMentionToken(bot)
}

type Translate = ReturnType<typeof useTranslate>

/** The chats this chat can mail now, in the Activity panel's order and with its rows; never the
 *  chat itself, a closed one, or a terminal-only automation run. */
function mailableChats(
  rows: readonly BotChatRow[],
  tree: readonly BotChatTreeChat[],
  bot: Bot,
  self: boolean,
  t: Translate
): NativeChatMentionChat[] {
  const mailable = new Map(
    rows
      .filter((row) => !row.closed && !row.self && !isBotGroupMemberSession(row.id))
      .map((row) => [row.id, row])
  )
  const listed = tree.filter((chat) => !chat.run && mailable.has(chat.chatId))
  const listedIds = new Set(listed.map((chat) => chat.chatId))
  // Not in the panel's read yet (a chat that just started): after, newest first.
  const unlisted = [...mailable.values()]
    .filter((row) => !listedIds.has(row.id))
    .sort((a, b) => Number(b.home) - Number(a.home) || b.lastActivityAt - a.lastActivityAt)
  const untitled = t('bots.chats.untitled', 'New chat')
  return [
    ...listed.map((chat): NativeChatMentionChat => {
      const title = chat.title || untitled
      return {
        id: chat.chatId,
        title,
        search: `${title}\n${chat.preview ?? ''}\n${chat.originLabel ?? ''}`,
        icon: <BotChatStatusSlot chat={chat} className="h-5 w-4" iconClassName="size-3.5" />,
        line: <BotChatLine bot={bot} chat={chat} folded={false} />,
        time: chat.lastActiveAt > 0 ? formatShortTimeAgo(chat.lastActiveAt) : null,
        plain: chat.origin === 'home' && !self
      }
    }),
    ...unlisted.map((row): NativeChatMentionChat => {
      const title = row.home ? t('bots.chats.home', 'Home Chat') : row.title || untitled
      const line = row.lastSaid ?? row.lastAsked ?? ''
      return {
        id: row.id,
        title,
        search: `${title}\n${line}`,
        icon: (
          <BotChatStatusSlot
            chat={{ origin: row.home ? 'home' : 'side', live: 'idle' }}
            className="h-5 w-4"
            iconClassName="size-3.5"
          />
        ),
        line,
        time: row.lastActivityAt > 0 ? formatShortTimeAgo(row.lastActivityAt) : null,
        plain: row.home && !self
      }
    })
  ]
}

/** A picked chat by the bot's latest read: checking until read, and never fine when in doubt. */
function chatPick(
  read: BotMentionChatsRead | null,
  bot: Bot,
  chatId: string,
  unreachable: string,
  t: Translate,
  retry: () => void
): NativeChatBotChatPick {
  if (read === null || read.status === 'loading') {
    return { state: 'checking' }
  }
  if (read.status === 'error') {
    return { state: 'unavailable', why: unreachable, retry }
  }
  const row = read.rows.find((entry) => entry.id === chatId)
  if (!row) {
    return {
      state: 'unavailable',
      why: t('bots.chat.mentionChatNotItsChat', "That chat isn't one of {{name}}'s.", {
        name: bot.name
      })
    }
  }
  const chat = row.home
    ? t('bots.chats.home', 'Home Chat')
    : row.title || t('bots.chats.untitled', 'New chat')
  const values = { name: bot.name, chat }
  if (row.self) {
    return {
      state: 'unavailable',
      why: t(
        'bots.chat.mentionChatSelf',
        '{{name}}\'s chat "{{chat}}" is this chat, so it can\'t take messages from it.',
        values
      )
    }
  }
  if (!row.closed) {
    return { state: 'ok' }
  }
  switch (row.reason) {
    case 'ended':
      return {
        state: 'unavailable',
        why: t(
          'bots.chat.mentionChatClosed',
          '{{name}}\'s chat "{{chat}}" was closed, so it can\'t take messages.',
          values
        )
      }
    case 'other-host':
      return {
        state: 'unavailable',
        why: t(
          'bots.chat.mentionChatElsewhere',
          '{{name}}\'s chat "{{chat}}" now runs on another computer, so it can\'t take messages from this chat.',
          values
        )
      }
    case 'unverifiable':
    case undefined:
      return {
        state: 'unavailable',
        why: t(
          'bots.chat.mentionChatUnverifiable',
          "Orca can't confirm this chat can take messages."
        )
      }
  }
}
