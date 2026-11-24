// End chat in a bot side chat row's menu (BotChatRowMenu), the same in the sidebar and the Activity
// panel, from a right-click and from the row's ⋯. The Home Chat, closed chats, thread chats and
// terminal-only runs offer none; the host decides the rest.
import { CircleX } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
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

/** Just below a row's lower left, so a menu opened from the keyboard leaves the row in view. */
export const KEYBOARD_MENU_GAP_PX = 4

/** Shift+F10 and the Menu key open a row's menu as a right-click does, anchored under the row. */
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
      clientX: box.left,
      clientY: box.bottom + KEYBOARD_MENU_GAP_PX
    })
  )
  return true
}

/** The row after the one the menu opened from (or before it, for the last), to take focus once that
 *  chat ends and its row goes. `from` is the row, an element around it, or one inside its box. */
function nextRow(from: Element | null): HTMLElement | null {
  if (!from) {
    return null
  }
  const rows = [...document.querySelectorAll<HTMLElement>(`[${BOT_CHAT_ROW_ATTRIBUTE}]`)]
  const at = rows.findIndex(
    (row) => row === from || from.contains(row) || row.parentElement?.contains(from) === true
  )
  return at === -1 ? null : (rows[at + 1] ?? rows[at - 1] ?? null)
}

/** Whether the row's menu offers End chat: the host can end chats, and this one is a side chat. */
export function useBotChatOffersEnd(
  bot: Pick<Bot, 'hostId'>,
  chat: Pick<BotChatTreeChat, 'origin' | 'closed' | 'run'>
): boolean {
  const supported = useBotHostHas(bot.hostId, BOTS_END_CHAT_RUNTIME_CAPABILITY)
  return supported && botChatHasEndMenu(chat)
}

/** What a row menu shares with its End chat: the element it opened from, and whether an end is under
 *  way, so the menu leaves focus to it rather than taking it back to its trigger as it closes. */
export type BotChatMenuOpener = { element: Element | null; ending: boolean }

/** End chat, in the row menu's right-click or ⋯ form. `openedFrom` reads where the menu opened;
 *  `onEnding` tells the menu an end is under way. */
export function BotChatEndItem({
  bot,
  chatId,
  kind,
  openedFrom,
  onEnding
}: {
  bot: Bot
  chatId: string
  kind: 'context' | 'dropdown'
  openedFrom: () => Element | null
  onEnding: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const end = (): void => {
    const from = openedFrom()
    const after = nextRow(from)
    onEnding()
    // Ended: its row goes, so the next one takes focus. Kept: back to where the menu opened.
    void endBotChatFromRow(bot, chatId).then((ended) => {
      const target = ended ? after : from instanceof HTMLElement ? from : null
      requestAnimationFrame(() => target?.focus())
    })
  }
  return (
    <Item onSelect={end}>
      <CircleX className="size-3.5" />
      {t('bots.endChat.menuItem', 'End chat')}
    </Item>
  )
}
