// The owner's answers in progress to items' asks, per question, for this app session. The card's picks
// and words survive a remount and a fold; when the question goes away first (replaced, withdrawn,
// answered elsewhere) the page offers them back instead of dropping them. A draft also keeps every id
// its answers went under: the same answer again reuses its id, and an answer under any of them is
// this card's own.
import { useSyncExternalStore } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import { commentOnBotItem } from './use-bot-items'
import { normalizeBotItemAnswers } from '../../../../../shared/bots/bot-item-ask'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

export type BotItemAnswerDraft = {
  prompt: AskPrompt
  selections: number[][]
  otherText: string[]
  /** The answer last sent and its id, reused while the same answer is sent again. */
  sent?: { key: string; id: string }
  /** Every id an answer from this card went under, with the answer it submitted (first send only; a
   *  retry under the same id never replaces it). Once one is known recorded, the draft is done only
   *  if it still holds that answer and no words that were never sent. */
  attempts?: Readonly<Record<string, string>>
  /** In flight: the question may close under it because this answer took it. */
  sending?: true
  /** The attempt the host said it recorded. */
  answeredId?: string
  /** An answer went and no reply came: it may be recorded. */
  uncertain?: true
  /** An older host took it as a plain comment, not a recorded answer. */
  sentAsComment?: true
  /** The comment for an older host got no reply: it may have gone. It goes again only when the owner
   *  says so, after checking Activity. */
  commentUnconfirmed?: { text: string }
  /** That comment is going again now. */
  commentSending?: true
}

// The card's mark for "the typed words are the answer" among a question's picks.
const TYPED_ANSWER = -1

type DraftWords = Pick<BotItemAnswerDraft, 'prompt' | 'selections' | 'otherText'>

/** Per question: the picks, the typed words, and whether those words are the answer (chosen). */
function draftParts(draft: DraftWords): { picks: number[]; typed: string; chosen: boolean }[] {
  return draft.prompt.questions.map((question, index) => {
    const selected = draft.selections[index] ?? []
    const typed = draft.otherText[index]?.trim() ?? ''
    return {
      picks: selected.filter((pick) => pick >= 0),
      typed,
      chosen: typed.length > 0 && (selected.includes(TYPED_ANSWER) || question.options.length === 0)
    }
  })
}

/** The answer a send would submit, keyed as the card keys the answer it sends for this question. */
export function botItemAnswerDraftSubmission(draft: DraftWords, eventId: string): string {
  const answers = normalizeBotItemAnswers(
    draftParts(draft).map(({ picks, typed, chosen }) => ({ picks, text: chosen ? typed : '' }))
  )
  return JSON.stringify([eventId, answers])
}

/** Whether the draft holds words a send leaves out: typed but not chosen, before or after sending. */
export function botItemAnswerDraftHasUnsentWords(draft: DraftWords): boolean {
  return draftParts(draft).some(({ typed, chosen }) => typed.length > 0 && !chosen)
}

type Drafts = ReadonlyMap<string, BotItemAnswerDraft>

// Words and picks change it in place (nothing shows them but the card); a mark or a drop replaces it,
// so who reads it as a snapshot sees that change.
let drafts = new Map<string, BotItemAnswerDraft>()
const listeners = new Set<() => void>()

function changed(): void {
  drafts = new Map(drafts)
  listeners.forEach((listener) => listener())
}

export function botItemAnswerDraftKey(botKey: string, uid: string, eventId: string): string {
  return `${botKey}\u0000${uid}\u0000${eventId}`
}

export function readBotItemAnswerDraft(key: string): BotItemAnswerDraft | undefined {
  return drafts.get(key)
}

/** The card's words and picks as they change; nothing re-renders for them. */
export function saveBotItemAnswerDraft(
  key: string,
  prompt: AskPrompt,
  selections: number[][],
  otherText: string[]
): void {
  drafts.set(key, { ...drafts.get(key), prompt, selections, otherText })
}

/** A change the page shows (sending, sent as a comment), which re-renders who reads drafts. */
export function markBotItemAnswerDraft(
  key: string,
  patch: Partial<
    Pick<
      BotItemAnswerDraft,
      | 'sent'
      | 'attempts'
      | 'sending'
      | 'answeredId'
      | 'uncertain'
      | 'sentAsComment'
      | 'commentUnconfirmed'
      | 'commentSending'
    >
  >
): void {
  const draft = drafts.get(key)
  if (draft) {
    drafts.set(key, { ...draft, ...patch })
    changed()
  }
}

export function dropBotItemAnswerDraft(key: string): void {
  if (drafts.has(key)) {
    drafts.delete(key)
    changed()
  }
}

// Drafts whose comment is being posted now: one post at a time each, whoever asks.
const commentsInFlight = new Set<string>()

/** An older host's comment for this answer, one post at a time per draft: on a reply it is sent; with
 *  none it may have gone, and the page says so and waits for the owner's Send again. Never retried
 *  on its own, and a failure never undoes a post that already went. `settled` runs after either. */
export async function sendBotItemAnswerAsComment(
  bot: BotRef,
  uid: string,
  key: string,
  text: string,
  settled?: () => void
): Promise<void> {
  if (commentsInFlight.has(key)) {
    return
  }
  commentsInFlight.add(key)
  markBotItemAnswerDraft(key, { commentSending: true })
  try {
    await commentOnBotItem(bot, uid, text, [])
    markBotItemAnswerDraft(key, { sentAsComment: true, commentUnconfirmed: undefined })
  } catch {
    if (!drafts.get(key)?.sentAsComment) {
      markBotItemAnswerDraft(key, { commentUnconfirmed: { text } })
    }
  } finally {
    commentsInFlight.delete(key)
    markBotItemAnswerDraft(key, { commentSending: undefined })
    settled?.()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The drafts as of the last mark or drop. */
export function useBotItemAnswerDrafts(): Drafts {
  return useSyncExternalStore(subscribe, () => drafts)
}

function hasContent(draft: BotItemAnswerDraft): boolean {
  return (
    draft.selections.some((picks) => picks.some((pick) => pick >= 0)) ||
    draft.otherText.some((text) => text.trim().length > 0)
  )
}

/** This item's drafts the page must show: for a question no longer open here, or one an older host
 *  took (or may have taken) as a comment. Not while its answer is in flight. */
export function botItemAnswerDraftsToRecover(
  all: Drafts,
  botKey: string,
  uid: string,
  openEventId: string | null
): { key: string; eventId: string; draft: BotItemAnswerDraft }[] {
  const prefix = `${botKey}\u0000${uid}\u0000`
  return [...all.entries()].flatMap(([key, draft]) => {
    const eventId = key.slice(prefix.length)
    return key.startsWith(prefix) &&
      !draft.sending &&
      hasContent(draft) &&
      (eventId !== openEventId || draft.sentAsComment || draft.commentUnconfirmed)
      ? [{ key, eventId, draft }]
      : []
  })
}

/** The draft as text: each question, then the answer it held (its picks, and its typed words when
 *  they were chosen), and apart from it any words typed but not chosen, so neither reads as the other. */
export function botItemAnswerDraftText(draft: BotItemAnswerDraft): string {
  return draft.prompt.questions
    .map((question, index) => {
      const selected = draft.selections[index] ?? []
      const picks = selected
        .filter((pick) => pick >= 0)
        .map((pick) => question.options[pick]?.label ?? '')
      const typed = draft.otherText[index]?.trim() ?? ''
      const typedChosen =
        typed.length > 0 && (selected.includes(TYPED_ANSWER) || question.options.length === 0)
      const answer = [...picks, ...(typedChosen ? [typed] : [])].join(', ')
      const unchosen = typed && !typedChosen ? `\n(typed, not chosen: ${typed})` : ''
      return `${question.question}\n→ ${answer || '—'}${unchosen}`
    })
    .join('\n\n')
}
