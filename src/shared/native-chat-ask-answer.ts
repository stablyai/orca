// Deliver answers as pasted messages or Claude/Codex selector keystrokes.

import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

/** Option indices in display order plus free text; selectors address stable numbers rather than labels. */
export type AskAnswerSelection = { indices: number[]; other?: string }

/** raw is verbatim PTY input; text must pass through the caller’s paste sanitizer. */
export type AskAnswerKeyGroup = { raw: string } | { text: string }

function isAnswered(sel: AskAnswerSelection | undefined): boolean {
  return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0
}

function answerLabels(question: AskQuestion, sel: AskAnswerSelection | undefined): string[] {
  const labels = (sel?.indices ?? [])
    .map((i) => question.options[i]?.label ?? '')
    .filter((l) => l.length > 0)
  const other = (sel?.other ?? '').trim()
  return other ? [...labels, other] : labels
}

/** One answer line per question, including unanswered empty lines. Message replies quote answered questions as > question\n\nanswer, matching Codex clients. */
export function formatAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): string {
  if (prompt.replyAsMessage) {
    return prompt.questions
      .flatMap((q, i) => {
        const answer = answerLabels(q, selections[i]).join(', ')
        return answer ? [`> ${q.question.replaceAll(/[\r\n]+/g, ' ')}\n\n${answer}`] : []
      })
      .join('\n\n')
  }
  return prompt.questions.map((q, i) => answerLabels(q, selections[i]).join(', ')).join('\n')
}

// Claude commits the highlighted default on Enter; pasted labels do not select it (STA-1860).
// Use stable 1-based option numbers and right-arrow between tabs. Space navigation/Enter writes so rendering applies selection before commit; verified live.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'
const ASK_PREVIEW_NOTES = 'n'

/** Pace selector groups so each step renders before the next. Single-select digits commit/advance;
 * free text uses Type something + Enter; multi-select digits toggle before the next/Submit tab.
 * Preview picks focus a row, attach optional notes, then commit with Enter. Multi-question/lone
 * multi-select prompts end with Submit confirmation; tool caps keep all row numbers single-digit. */
export function buildAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const questions = prompt.questions
  const multiQuestion = questions.length > 1
  const groups: AskAnswerKeyGroup[] = []

  questions.forEach((q, qi) => {
    const sel = selections[qi]
    const other = (sel?.other ?? '').trim()
    const typeSomething = String(q.options.length + 1)

    if (q.hasPreviews && (other || (sel?.indices.length ?? 0) > 0)) {
      const index = sel?.indices[0]
      if (index === 0 && other && q.options.length > 1) {
        // Why: a note commits its row only once focus has moved, and row 1 starts focused.
        groups.push({ raw: '2' }, { raw: '1' })
      } else if (index !== undefined) {
        groups.push({ raw: String(index + 1) })
      }
      if (other) {
        groups.push({ raw: ASK_PREVIEW_NOTES }, { text: other })
      }
      groups.push({ raw: ASK_ENTER })
    } else if (q.multiSelect) {
      for (const i of sel?.indices ?? []) {
        groups.push({ raw: String(i + 1) })
      }
      if (other) {
        groups.push({ raw: typeSomething }, { text: other }, { raw: ASK_ENTER })
      }
      // Multi-select never auto-advances; move to the next question or final Submit tab.
      groups.push({ raw: ASK_NEXT_TAB })
    } else if (other) {
      // Route single-select answers containing free text through Type something as one string.
      groups.push(
        { raw: typeSomething },
        { text: answerLabels(q, sel).join(', ') },
        { raw: ASK_ENTER }
      )
    } else if ((sel?.indices.length ?? 0) > 0) {
      groups.push({ raw: String(sel!.indices[0]! + 1) })
    } else if (multiQuestion) {
      // Unanswered question in a multi-question prompt: step past it.
      groups.push({ raw: ASK_NEXT_TAB })
    }
  })

  const endsOnSubmitTab =
    multiQuestion || (questions.length === 1 && questions[0]!.multiSelect === true)
  if (endsOnSubmitTab && groups.length > 0) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}

/** Codex commits on the final option digit; notes attach to the highlighted row. Start at row one, navigate without commit, Tab to notes, then Enter. */
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

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}
