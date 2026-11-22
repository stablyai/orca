// What a chat that closes itself says: its strip over the composer and its row's line.
import type { Translate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { BotChatAutoCloseView } from '../../../../shared/bots/bot-chat-auto-close'

/** A time today ("3:42 PM"), else a day ("Nov 20"). */
export function botChatCloseMoment(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return uiDateTimeFormat(
    sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }
  ).format(at)
}

/** Whole minutes left, at least 1: the strip changes only as each minute passes. */
export function botChatCloseMinutesLeft(closesAt: number, now: number): number {
  return Math.max(1, Math.ceil((closesAt - now) / 60_000))
}

export function botChatAutoCloseStripText(
  t: Translate,
  view: BotChatAutoCloseView,
  now: number
): string {
  if (view.phase === 'held') {
    return t(
      'bots.chats.autoClose.held',
      'Closing paused while this chat is open or has an unsent message.'
    )
  }
  if (view.phase === 'kept') {
    return t('bots.chats.autoClose.kept', 'Kept open until new work finishes.')
  }
  return t(
    'bots.chats.autoClose.counting',
    'All items here are done or canceled. History is kept · Closes at {{time}} (in {{count}} min)',
    {
      time: botChatCloseMoment(view.closesAt, now),
      count: botChatCloseMinutesLeft(view.closesAt, now)
    }
  )
}

/** A row's line for a chat counting down, paused, or closed (by Orca or by its owner); null otherwise. */
export function botChatCloseRowText(
  t: Translate,
  chat: {
    closed: boolean
    closedAt?: number
    autoClose?: BotChatAutoCloseView
    autoClosedAt?: number
  },
  now: number
): string | null {
  if (chat.closed && chat.autoClosedAt) {
    return t('bots.chats.autoClose.closedByOrca', 'Closed by Orca · {{time}} · Reopen', {
      time: botChatCloseMoment(chat.autoClosedAt, now)
    })
  }
  if (chat.closed) {
    return chat.closedAt
      ? t('bots.chats.closedAt', 'Closed · {{time}}', {
          time: botChatCloseMoment(chat.closedAt, now)
        })
      : null
  }
  if (chat.autoClose?.phase === 'counting') {
    return t('bots.chats.autoClose.soon', 'Closing soon')
  }
  return chat.autoClose?.phase === 'held'
    ? t('bots.chats.autoClose.paused', 'Closing paused')
    : null
}
