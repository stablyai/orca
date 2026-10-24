// Encodes a user's answer to a pending question for delivery: the pasted text
// for agents that take a message, and the keystrokes that drive Claude's and
// Codex's terminal selectors.

import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

/** One question's chosen answer, normalized for delivery: the selected option
 *  indices (in option order) plus any free-text "other" answer. Index-based (not
 *  label text) so the answer can be delivered by the selector's stable option
 *  number — see `buildAskAnswerKeys`. */
export type AskAnswerSelection = { indices: number[]; other?: string }

/** A single keystroke group to write to the agent PTY. `raw` bytes (option
 *  numbers, Enter, arrows) are written verbatim as keystrokes; `text` is a
 *  free-text answer the caller runs through its paste sanitizer before writing. */
export type AskAnswerKeyGroup = { raw: string } | { text: string }

/** True when this question is answered (a picked option or typed free text). */
function isAnswered(sel: AskAnswerSelection | undefined): boolean {
  return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0
}

/** The picked labels + trimmed free text for one question, in option order. */
function answerLabels(question: AskQuestion, sel: AskAnswerSelection | undefined): string[] {
  const labels = (sel?.indices ?? [])
    .map((i) => question.options[i]?.label ?? '')
    .filter((l) => l.length > 0)
  const other = (sel?.other ?? '').trim()
  return other ? [...labels, other] : labels
}

/** Build the human-readable answer text: one line per question, in question
 *  order, each the selected label(s) + free text joined by ", ". Empty answers
 *  stay empty lines so N lines always == N questions. Used for agents whose
 *  question tool commits a pasted answer (not Claude's arrow-navigate selector).
 *  A `replyAsMessage` answer arrives detached from its question, so it quotes each
 *  answered question in the `> question\n\nanswer` form Codex's own clients send. */
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

// Claude's AskUserQuestion is an arrow-navigate selector: a bare Enter commits
// the HIGHLIGHTED default (the first option), and pasted label text does not move
// the highlight — so answering by label silently delivered every non-first pick
// as the first option (STA-1860). Instead we drive the selector by each option's
// stable 1-based number (which matches the card's badge), the marker it commits
// on. Right-arrow steps to the next question / the Submit tab. Verified live
// against Claude Code's TUI; groups are written spaced apart (see the senders)
// because a navigation keystroke batched with Enter commits before the selector
// has applied it.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'

/** Build the ordered keystroke groups that answer a Claude Code AskUserQuestion.
 *  Each group is written a step apart so the selector applies it before the next.
 *
 *  - single-select pick  → the option number (selects AND commits; in a
 *    multi-question prompt it auto-advances to the next question)
 *  - free-text answer    → the "Type something" row number, the text, then Enter
 *  - multi-select        → each option number TOGGLES its checkbox, then a step
 *    to the Submit tab
 *  - a multi-question prompt (and a lone multi-select) finishes on a Submit
 *    confirmation, so it ends with one Enter
 *
 *  (Option counts are ≤ the tool's cap of a few, so single-digit numbers always
 *  address every row.) */
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

    if (q.multiSelect) {
      for (const i of sel?.indices ?? []) {
        groups.push({ raw: String(i + 1) })
      }
      if (other) {
        groups.push({ raw: typeSomething }, { text: other }, { raw: ASK_ENTER })
      }
      // A multi-select never auto-advances; step to the next tab (the Submit tab
      // when this is the last question).
      groups.push({ raw: ASK_NEXT_TAB })
    } else if (other) {
      // Single-select can only carry one value, so route any answer that
      // includes free text through the "Type something" row as one string.
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

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}
