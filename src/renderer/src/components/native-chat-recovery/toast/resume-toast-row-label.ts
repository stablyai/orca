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
