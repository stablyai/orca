import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  translatedSlotParts,
  type TranslatedSlotPart
} from '../../../../../shared/i18n/translated-slot-order'
import { findBotByWorkspace } from '../../bots/bot-workspace'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'

type ListedBot = Pick<Bot, 'name' | 'folderWorkspaceId'> & { hostId: ExecutionHostId }

/** Every bot's own chat is "Home", so a bot's chats are named with it; a terminal worker started
 *  in a bot's folder is not the bot's chat. Only this host's bots, so another host's never answers. */
export function resumeRowBotName(
  bots: readonly ListedBot[],
  candidate: Pick<ResumeCandidate, 'workspaceId' | 'surface'>,
  hostId: ExecutionHostId
): string | undefined {
  return candidate.surface === 'terminal'
    ? undefined
    : findBotByWorkspace(bots, candidate.workspaceId, hostId)?.name
}

export type BotChatLabelPart = TranslatedSlotPart<'bot' | 'chat'>

const BOT_MARKER = '\u0001'
const CHAT_MARKER = '\u0002'
const BOT: BotChatLabelPart = { key: 'bot', kind: 'bot' }
const CHAT: BotChatLabelPart = { key: 'chat', kind: 'chat' }
const SLOTS = [
  { marker: BOT_MARKER, part: BOT },
  { marker: CHAT_MARKER, part: CHAT }
]
const ENGLISH_ORDER: BotChatLabelPart[] = [BOT, { key: 'text-1', kind: 'text', text: ' · ' }, CHAT]

/** "<bot> · <chat>" in the locale's order, in pieces so the row can lay out each one. */
export function botChatLabelParts(t: Translate): BotChatLabelPart[] {
  return translatedSlotParts(
    t('auto.components.NativeChatResumeToast.botChat', '{{bot}} · {{chat}}', {
      bot: BOT_MARKER,
      chat: CHAT_MARKER,
      interpolation: { escapeValue: false }
    }),
    SLOTS,
    ENGLISH_ORDER
  )
}

export function botChatLabelText(parts: readonly BotChatLabelPart[], bot: string, chat: string) {
  return parts
    .map((part) => (part.kind === 'bot' ? bot : part.kind === 'chat' ? chat : part.text))
    .join('')
}

// Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms.
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/
const DIGIT_SUFFIX = /\s?[0-9]+$/

/** A name's trailing instance number (" 01"), kept whole while the rest ellipsizes; null when the
 *  name has none, or is right-to-left, where splitting it would reorder it. */
export function botNameDigitSuffix(name: string): { head: string; digits: string } | null {
  const digits = RTL_CHARS.test(name) ? null : DIGIT_SUFFIX.exec(name)?.[0]
  return digits && digits.length < name.length
    ? { head: name.slice(0, -digits.length), digits }
    : null
}

const SHOWN_LITERALS_MAX = 4

/** The pieces as the row shows them: a translation whose text around the names runs past a few
 *  characters in all is shown in the default order, so the names always keep their room. */
export function shownBotChatParts(parts: BotChatLabelPart[]): BotChatLabelPart[] {
  const literalLength = parts.reduce(
    (length, part) => length + (part.kind === 'text' ? Array.from(part.text).length : 0),
    0
  )
  return literalLength > SHOWN_LITERALS_MAX ? ENGLISH_ORDER : parts
}
