// An ask's answers held on this device, in chat's draft store so a reload keeps them: picked or typed
// on its card, until the host has the comment that sent them.
import { useCallback, useMemo } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  botItemQuestionLeads,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemHeldAnswersText,
  botItemNamedAnswerLines,
  botItemNamedAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import type { BotItemPendingIntent } from '../../../../../shared/bots/bot-item-pending-comments'
import { botItemHeldWordsMatch } from '../../../../../shared/bots/bot-item-refused-reply'
import { useNativeChatDraft } from '../../native-chat/drafts/use-native-chat-draft'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../native-chat/drafts/native-chat-draft-views'

const NOT_COMPOSING = (): boolean => false

export function botItemHeldAnswersScope(bot: BotRef, itemUid: string, askId: string): string {
  return `bot-item-answers:${botRefKey(bot)}:${itemUid}:${askId}`
}

/** An ask's answers held on this device, per question line, stored as the comment they post as (an
 *  open line whose first line another question shares keeps its place as a bare "Question →"). */
export function useBotItemHeldAnswers(
  scopeKey: string,
  shape: BotItemQuestionShape
): { held: (string | null)[]; hold: (answers: readonly (string | null)[]) => void } {
  const { draft, setDraft } = useNativeChatDraft(scopeKey, NOT_COMPOSING)
  const held = useMemo(() => botItemNamedAnswers(shape, draft), [shape, draft])
  const hold = useCallback(
    (answers: readonly (string | null)[]) => setDraft(botItemHeldAnswersText(shape, answers)),
    [setDraft, shape]
  )
  return { held, hold }
}

/** The host has a send (or may: one discarded after it may have arrived): each answer it sent leaves
 *  the ask's held picks, question by question, only where that question's line still holds exactly
 *  what was sent. Lines picked since, or added to the ask after it was sent, stay as they are; a sent
 *  line whose first line another question shares leaves its bare "Question →", so the lines after it
 *  keep their place. */
export function botItemClearDeliveredAnswers(scopeKey: string, intent: BotItemPendingIntent): void {
  const { shape, answers } = intent
  const draft = readNativeChatDraftCache(scopeKey)
  const named = botItemNamedAnswerLines(shape, draft)
  const cleared = new Map<number, string>()
  answers.forEach((words, index) => {
    const line = named[index]
    if (words && line?.words && botItemHeldWordsMatch(line.words, words)) {
      cleared.set(line.lineIndex, line.head)
    }
  })
  if (cleared.size === 0) {
    return
  }
  const lines = draft.split('\n')
  const kept = lines.flatMap((line, at) => {
    const head = cleared.get(at)
    if (head === undefined) {
      return [line]
    }
    // A later line with this head may belong to a question appended after the send.
    const keepsPlace = lines.some(
      (later, index) => index > at && !cleared.has(index) && later.trim().startsWith(head)
    )
    return keepsPlace ? [head] : []
  })
  // Only places left: nothing is held.
  const heads = new Set(
    shape.decisions.flatMap((decision) =>
      botItemQuestionLeads(decision.question).map((lead) => `${lead} →`)
    )
  )
  writeNativeChatDraftCache(
    scopeKey,
    kept.every((line) => line.trim() === '' || heads.has(line.trim())) ? '' : kept.join('\n')
  )
}
