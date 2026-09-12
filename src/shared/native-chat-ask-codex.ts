import { ASK_ENTER, type AskAnswerKeyGroup, type AskAnswerSelection } from './native-chat-ask'
import type { AskPrompt } from './native-chat-ask-types'

const ASK_NEXT_TAB = '\x1b[C'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'

/** Build keystrokes for Codex's request_user_input overlay.
 *
 * Unlike Claude, Codex submits on the final option digit and attaches free text
 * as notes to the highlighted row. The overlay starts on the first row, so note
 * answers move to the target without committing, open notes with Tab, then
 * submit with Enter. */
export function buildCodexAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  let hasUnanswered = false

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const selectedIndex = selection?.indices[0]
    const note = (selection?.other ?? '').trim()

    if (note) {
      const targetIndex = selectedIndex ?? question.options.length
      const rowCount = question.options.length + 1
      const nextSteps = targetIndex
      const previousSteps = rowCount - targetIndex
      const usePrevious = previousSteps < nextSteps
      const navigationKey = usePrevious ? ASK_PREVIOUS_ROW : ASK_NEXT_ROW
      const navigationSteps = usePrevious ? previousSteps : nextSteps
      for (let index = 0; index < navigationSteps; index += 1) {
        groups.push({ raw: navigationKey })
      }
      groups.push({ raw: ASK_NOTES }, { text: note }, { raw: ASK_ENTER })
      return
    }

    if (selectedIndex !== undefined) {
      groups.push({ raw: String(selectedIndex + 1) })
      return
    }

    hasUnanswered = true
    groups.push({ raw: '\x7f' })
    if (questionIndex < prompt.questions.length - 1) {
      groups.push({ raw: ASK_NEXT_TAB })
    } else {
      groups.push({ raw: ASK_ENTER })
    }
  })

  // Codex opens a confirmation after the last question when any were skipped;
  // Proceed is highlighted by default, so one Enter submits the partial answer.
  if (hasUnanswered) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}
