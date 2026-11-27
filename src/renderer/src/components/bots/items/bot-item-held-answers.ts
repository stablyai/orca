// An ask's answers held on this device, in chat's draft store so a reload keeps them: picked or typed
// on its card, until the host has the comment that sent them. What a held answer is, and how it is
// stored, is the shared model's (src/shared/bots/bot-item-held-answers).
import { useCallback, useMemo } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import type { Translate } from '@/i18n/use-translate'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import {
  botItemHeldAnswersAfterDelivery,
  readBotItemHeldAnswers,
  writeBotItemHeldAnswers,
  type BotItemHeldAnswer,
  type BotItemHeldAnswers,
  type BotItemHeldAnswersLimit
} from '../../../../../shared/bots/bot-item-held-answers'
import type { BotItemPendingIntent } from '../../../../../shared/bots/bot-item-pending-comments'
import { useNativeChatDraft } from '../../native-chat/drafts/use-native-chat-draft'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../native-chat/drafts/native-chat-draft-views'
import { returnMessageToComposer } from '../../native-chat/session/structured/delivery/structured-agent-session-message-hand-back'

const NOT_COMPOSING = (): boolean => false

export function botItemHeldAnswersScope(bot: BotRef, itemUid: string, askId: string): string {
  return `bot-item-answers:${botRefKey(bot)}:${itemUid}:${askId}`
}

/** An ask's answers held on this device, per question line. */
export function useBotItemHeldAnswers(
  scopeKey: string,
  shape: BotItemQuestionShape
): { held: (BotItemHeldAnswer | null)[]; hold: (answers: BotItemHeldAnswers) => void } {
  const { draft, setDraft } = useNativeChatDraft(scopeKey, NOT_COMPOSING)
  const held = useMemo(() => readBotItemHeldAnswers(shape, draft), [shape, draft])
  const hold = useCallback(
    (answers: BotItemHeldAnswers) => setDraft(writeBotItemHeldAnswers(shape, answers)),
    [setDraft, shape]
  )
  return { held, hold }
}

/** The host has a send (or may: one discarded after it may have arrived): each answer it sent leaves
 *  the ask's held answers, where that question still holds what was sent. */
export function botItemClearDeliveredAnswers(scopeKey: string, intent: BotItemPendingIntent): void {
  writeNativeChatDraftCache(
    scopeKey,
    botItemHeldAnswersAfterDelivery(readNativeChatDraftCache(scopeKey), intent)
  )
}

/** A held answer back in a comment box's draft (`boxScope`), after its words, as chat hands back a
 *  message it didn't send: its [Image #N] become chips of its images again, its skills pills. True
 *  once the draft is saved: only then may the held copy go, or a reload could lose the answer. */
export function returnBotItemHeldAnswer(
  boxScope: string,
  { words, images, skills }: BotItemHeldAnswer
): boolean {
  return returnMessageToComposer(
    boxScope,
    `held-${createNonSecureContextUuid()}`,
    [
      { type: 'text', text: words },
      ...images.map((path) => ({ type: 'image-ref' as const, path }))
    ],
    undefined,
    undefined,
    [...skills]
  )
}

/** Why the box kept an answer: the held answers with it would pass one comment's limit. */
export function botItemHeldAnswersLimitNotice(
  t: Translate,
  { kind, max }: BotItemHeldAnswersLimit
): string {
  return kind === 'images'
    ? t(
        'bots.items.ask.heldImagesLimit',
        'Your answers go as one comment, which takes up to {{max}} images. Send the answers held so far first, or remove some.',
        { max }
      )
    : t(
        'bots.items.ask.heldSkillsLimit',
        'Your answers go as one comment, which takes up to {{max}} skills. Send the answers held so far first, or remove some.',
        { max }
      )
}
