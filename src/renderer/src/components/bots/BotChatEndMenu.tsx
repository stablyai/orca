// A bot side chat row's menu: End chat, the same in the sidebar and the Activity panel. The Home Chat,
// closed chats, thread chats and terminal-only runs get no menu; the host decides the rest.
import { useRef } from 'react'
import { CircleX } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostHas } from '@/lib/bot-host-status'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { BOTS_END_CHAT_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { endBotChatFromRow } from './bot-chat-end'

/** Marks a chat row's focus stop, so focus can move on to the next row once a chat ends. */
export const BOT_CHAT_ROW_ATTRIBUTE = 'data-bot-chat-row'

const THREAD_ORIGINS = new Set<BotChatTreeChat['origin']>(['slack', 'linear', 'github'])

export function botChatHasEndMenu(
  chat: Pick<BotChatTreeChat, 'origin' | 'closed' | 'run'>
): boolean {
  return chat.origin !== 'home' && !THREAD_ORIGINS.has(chat.origin) && !chat.closed && !chat.run
}

/** Shift+F10 and the Menu key open a row's menu where it sits, as a right-click does. */
export function openRowMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
    return false
  }
  event.preventDefault()
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + Math.min(24, box.width / 2),
      clientY: box.top + box.height / 2
    })
  )
  return true
}

function nextRow(from: Element | null): HTMLElement | null {
  if (!from) {
    return null
  }
  const rows = [...document.querySelectorAll<HTMLElement>(`[${BOT_CHAT_ROW_ATTRIBUTE}]`)]
  const at = rows.findIndex((row) => row === from || from.contains(row))
  return at === -1 ? null : (rows[at + 1] ?? rows[at - 1] ?? null)
}

export function BotChatEndMenu({
  bot,
  chat,
  children
}: {
  bot: Bot
  chat: Pick<BotChatTreeChat, 'chatId' | 'origin' | 'closed' | 'run'>
  children: React.JSX.Element
}): React.JSX.Element {
  const t = useTranslate()
  const supported = useBotHostHas(bot.hostId, BOTS_END_CHAT_RUNTIME_CAPABILITY)
  const trigger = useRef<Element | null>(null)
  if (!supported || !botChatHasEndMenu(chat)) {
    return children
  }
  const end = (): void => {
    const after = nextRow(trigger.current)
    void endBotChatFromRow(bot, chat.chatId).then((ended) => {
      if (ended) {
        requestAnimationFrame(() => after?.focus())
      }
    })
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          trigger.current = event.currentTarget
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={end}>
          <CircleX className="size-3.5" />
          {t('bots.endChat.menuItem', 'End chat')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
