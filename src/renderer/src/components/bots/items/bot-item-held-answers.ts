// An ask's answers held on this device, in chat's draft store so a reload keeps them: picked or typed
// on its card, until the host has the comment that sent them.
import { useCallback, useMemo } from 'react'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  botItemLineHeads,
  botItemQuestionLeads,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import {
  botItemAnswersText,
  botItemHeldAnswersText,
  botItemNamedAnswerLines,
  botItemNamedAnswers
} from '../../../../../shared/bots/bot-item-answer-lines'
import type { BotItemPendingIntent } from '../../../../../shared/bots/bot-item-pending-comments'
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

/** The same words, as a held line writes them. */
function sameWords(held: string | null, sent: string): boolean {
  return held !== null && held === sent.replace(/\s+/g, ' ').trim()
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
  // Per draft line it clears, what that line leaves behind.
  const cleared = new Map<number, string | null>()
  answers.forEach((words, index) => {
    const line = named[index]
    if (words && line?.words && sameWords(line.words, words)) {
      const sharesHead = botItemLineHeads(shape, line.head).some(
        (head, other) => other !== index && head === line.head
      )
      cleared.set(line.lineIndex, sharesHead ? line.head : null)
    }
  })
  if (cleared.size === 0) {
    return
  }
  const kept = draft.split('\n').flatMap((line, at) => {
    const left = cleared.get(at)
    return left === undefined ? [line] : left === null ? [] : [left]
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

/** What a refused send of an ask of several questions gives back to the comment box: the words the
 *  ask's held picks don't keep (a line's words posted with files, or words riding along), as typed;
 *  the answers still held stay on the card, so a resend can't post them twice. */
export function botItemRefusedAnswerWords(
  scopeKey: string,
  intent: BotItemPendingIntent,
  text: string
): string {
  const { shape, answers } = intent
  const held = botItemNamedAnswers(shape, readNativeChatDraftCache(scopeKey))
  // Image marks alone go: the box gets words back, not the images.
  const unheld = answers.flatMap((words, index) =>
    words?.replace(/\[Image #\d+\]/g, '').trim() && !sameWords(held[index] ?? null, words)
      ? [words.trim()]
      : []
  )
  const answered = botItemAnswersText(shape, answers)
  // Its own words follow its answer lines; a comment that isn't so is given back whole.
  const rest = !answered
    ? text
    : text.startsWith(answered)
      ? text.slice(answered.length).replace(/^\n/, '')
      : null
  return rest === null ? text : [...unheld, rest].filter((part) => part.trim()).join('\n')
}
