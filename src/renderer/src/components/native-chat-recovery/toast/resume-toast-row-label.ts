import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  translatedSlotParts,
  type TranslatedSlotPart
} from '../../../../../shared/i18n/translated-slot-order'
import { findBotByWorkspace } from '../../bots/bot-workspace'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'

/** Every bot's own chat is "Home", so a bot's chats are named with it; a terminal worker started
 *  in a bot's folder is not the bot's chat. Only this host's bots, so another host's never answers. */
export function resumeRowBotName(
  bots: readonly Bot[],
  candidate: Pick<ResumeCandidate, 'workspaceId' | 'surface'>,
  hostId: ExecutionHostId
): string | undefined {
  return candidate.surface === 'terminal'
    ? undefined
    : findBotByWorkspace(bots, candidate.workspaceId, hostId)?.name
}

export type BotChatLabelPart = TranslatedSlotPart<'bot' | 'chat'>

const BOT_CHAT_SLOTS = { bot: '\u0001', chat: '\u0002' }
const ENGLISH_ORDER: BotChatLabelPart[] = [
  { key: 'bot', kind: 'bot' },
  { key: 'text-1', kind: 'text', text: ' · ' },
  { key: 'chat', kind: 'chat' }
]

/** "<bot> · <chat>" in the locale's order, in pieces so the row can lay out each one. */
export function botChatLabelParts(t: Translate): BotChatLabelPart[] {
  return translatedSlotParts(
    t('auto.components.NativeChatResumeToast.botChat', '{{bot}} · {{chat}}', {
      ...BOT_CHAT_SLOTS,
      interpolation: { escapeValue: false }
    }),
    BOT_CHAT_SLOTS,
    ENGLISH_ORDER
  )
}

export function botChatLabelText(parts: readonly BotChatLabelPart[], bot: string, chat: string) {
  return parts
    .map((part) => (part.kind === 'bot' ? bot : part.kind === 'chat' ? chat : part.text))
    .join('')
}

const KEPT_WORD_LENGTH = 9
const KEPT_CHARS = 6

/** A long name's end, kept whole while the rest ellipsizes, so "… Assistant 01" and "… 02" stay apart. */
export function nameKeptEnd(name: string): { head: string; tail: string } {
  const chars = Array.from(name)
  if (chars.length <= KEPT_WORD_LENGTH + KEPT_CHARS) {
    return { head: name, tail: '' }
  }
  const lastSpace = name.lastIndexOf(' ')
  const lastWord = lastSpace > 0 ? name.slice(lastSpace) : ''
  const tail =
    lastWord && Array.from(lastWord).length <= KEPT_WORD_LENGTH
      ? lastWord
      : chars.slice(-KEPT_CHARS).join('')
  return { head: name.slice(0, name.length - tail.length), tail }
}
