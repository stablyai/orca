// What an item reply the host refused as replaced gives back to the comment box, on desktop and phone.
import { botItemAnswersText } from './bot-item-answer-lines'
import { botItemHeldAnswerWas, readBotItemHeldAnswers } from './bot-item-held-answers'
import type { BotItemPendingIntent } from './bot-item-pending-comments'

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
  const kept = readBotItemHeldAnswers(shape, held)
  // Image marks alone go: the box gets words back, not the images.
  const unheld = answers.flatMap((words, index) =>
    words?.replace(/\[Image #\d+\]/g, '').trim() &&
    !botItemHeldAnswerWas(kept[index] ?? null, words)
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
