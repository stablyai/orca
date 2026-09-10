import type { AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'

/** How one submission splits across the two channels available to the user.
 *
 *  `selectorSelections` is what the selector can express — picks, each carrying
 *  its own note. `chatText` is everything typed with no pick to ride on, which
 *  has no selector representation and travels as an ordinary chat message. */
export type AskAnswerRouting = {
  selectorSelections: AskAnswerSelection[]
  chatText: string
  /** True when nothing is picked anywhere, so the question is rejected outright
   *  and the words become the whole reply. */
  rejectsPrompt: boolean
}

/** Split a submission into selector answers and escape-to-chat text.
 *
 *  A note attaches to a selected option, so free text without a pick cannot be
 *  delivered through the selector at all. Rather than dropping it, route it to
 *  chat — mirroring the TUI's own "Chat about this", which rejects the question
 *  and returns the user to the conversation. */
export function routeAskAnswer(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerRouting {
  const selectorSelections: AskAnswerSelection[] = []
  const strandedText: string[] = []
  let anyPicked = false

  prompt.questions.forEach((question, i) => {
    const selection = selections[i]
    const indices = selection?.indices ?? []
    const other = (selection?.other ?? '').trim()
    if (indices.length > 0) {
      anyPicked = true
      selectorSelections.push({ indices: [...indices], other })
      return
    }
    // No pick: the selector has nothing to attach these words to.
    selectorSelections.push({ indices: [], other: '' })
    if (other) {
      strandedText.push(
        prompt.questions.length > 1 && question.question ? `${question.question}\n${other}` : other
      )
    }
  })

  return {
    selectorSelections,
    chatText: strandedText.join('\n\n'),
    rejectsPrompt: !anyPicked && strandedText.length > 0
  }
}
