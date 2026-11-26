// What a device's sends on their way answer: shown on their ask's lines until the host's read has them.
import { botItemAnswersText, botItemWordsBesideAnswers } from './bot-item-answer-lines'
import { botItemCommentFiles } from './bot-item-comment-files'
import { botItemPendingCommentText, type BotItemPendingComment } from './bot-item-pending-comments'

const NO_SENT: ReadonlyMap<string, readonly (string | null)[]> = new Map()

/** Per ask, the answers of its sends still on their way, by line. An ask of several questions counts a
 *  failed one too (its Retry or Discard is in the Activity), so its lines can't be sent twice; one of
 *  one question shows a failed send as itself, as it always has. */
export function botItemSentAnswers(
  pending: readonly BotItemPendingComment[]
): ReadonlyMap<string, readonly (string | null)[]> {
  const sent = new Map<string, (string | null)[]>()
  for (const { intent, failed } of pending) {
    if (!intent || (failed && intent.shape.decisions.length < 2)) {
      continue
    }
    const lines = sent.get(intent.askId) ?? intent.shape.decisions.map(() => null)
    intent.answers.forEach((words, index) => {
      if (words && index < lines.length) {
        lines[index] = words
      }
    })
    sent.set(intent.askId, lines)
  }
  return sent.size > 0 ? sent : NO_SENT
}

/** A send the ask's lines show whole: its words are exactly its answers, with no files (attached or
 *  named in them) or skills. Anything more shows as its own comment too. */
export function botItemPendingAnswersOnly(entry: BotItemPendingComment): boolean {
  const { intent, failed, paths, skills } = entry
  if (failed || !intent || paths.length > 0 || (skills?.length ?? 0) > 0) {
    return false
  }
  const text = botItemPendingCommentText(entry).trim()
  const words = intent.shape.decisions.length > 1 ? null : intent.answers[0]?.trim()
  return (
    text !== '' &&
    botItemCommentFiles(text).files.length === 0 &&
    text === (words === null ? botItemAnswersText(intent.shape, intent.answers) : words)
  )
}

/** A send of answers to several questions with the owner's own words: those words, which show as its
 *  comment while its answers show on the ask's lines. */
export function botItemPendingWordsBesideAnswers(entry: BotItemPendingComment): string | null {
  const { intent } = entry
  return intent && intent.shape.decisions.length > 1 && intent.rideAlongText !== undefined
    ? botItemWordsBesideAnswers(
        intent.shape,
        botItemPendingCommentText(entry),
        intent.answers.map(Boolean)
      )
    : null
}
