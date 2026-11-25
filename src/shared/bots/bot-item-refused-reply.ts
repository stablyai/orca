// What an item reply the host refused as replaced gives back to the comment box, on desktop and phone.
import { botItemAnswersText, botItemNamedAnswers } from './bot-item-answer-lines'
import type { BotItemPendingIntent } from './bot-item-pending-comments'

/** The same words, as a held line writes them. */
export function botItemHeldWordsMatch(held: string | null, sent: string): boolean {
  return held !== null && held === sent.replace(/\s+/g, ' ').trim()
}

/** What a refused reply gives back to the comment box. An ask of several questions keeps the answers
 *  its held picks (`held`, the ask's held-answers draft) still have on its card, so a resend can't post
 *  them twice; every other word goes back as typed. An entry from before `intent` gives its text. */
export function botItemRefusedReplyText(
  intent: BotItemPendingIntent | undefined,
  text: string,
  held: string
): string {
  if (!intent || intent.shape.decisions.length < 2) {
    return text
  }
  const { shape, answers, rideAlongText } = intent
  const kept = botItemNamedAnswers(shape, held)
  // Image marks alone go: the box gets words back, not the images.
  const unheld = answers.flatMap((words, index) =>
    words?.replace(/\[Image #\d+\]/g, '').trim() &&
    !botItemHeldWordsMatch(kept[index] ?? null, words)
      ? [words.trim()]
      : []
  )
  const original = rideAlongText ?? text
  const prefix = rideAlongText === undefined ? botItemAnswersText(shape, answers) : ''
  if (!original.startsWith(prefix)) {
    return text
  }
  const rest = prefix ? original.slice(prefix.length).replace(/^\n/, '') : original
  return [...unheld, rest].filter((part) => part.trim()).join('\n')
}
