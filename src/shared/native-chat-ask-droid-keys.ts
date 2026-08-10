// Keystrokes that answer Droid's AskUser selector.
//
// Droid's selector has NO option-number shortcuts: any printable character
// switches the row into "own answer" text entry, so a digit would type "1" as
// free text instead of picking option 1 (the STA-1860 failure mode, one agent
// over). Its verified state machine, read off the shipped binary:
//
//   - each question starts highlighted on option 0; up/down move the highlight,
//     and down past the last option enters own-answer text entry
//   - single-select: Enter commits the highlighted option
//   - multi-select: Enter TOGGLES the highlighted checkbox; right-arrow submits
//     the checked set
//   - own answer: the first printable input becomes the text, Enter commits it
//     (multi-select instead moves focus to Continue, which Enter then submits)
//   - committing an answer jumps to the next question with no answer yet, and
//     the whole questionnaire is submitted once every question has one
//
// That last rule is why this walks Droid's cursor rather than assuming one
// question per pass: a skipped question stays selected, and every later
// keystroke would otherwise land on the wrong question.

import type {
  AskAnswerKeyGroup,
  AskAnswerSelection,
  AskPrompt,
  AskQuestion
} from './native-chat-ask-types'

const ENTER = '\r'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const TAB = '\t'

/** Droid reads a paste as one printable input, so the text must stay single-line:
 *  a multi-line body would be bracketed-paste framed, and the selector drops any
 *  input containing an escape while it is showing options. */
function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim()
}

function pickedLabels(question: AskQuestion, selection: AskAnswerSelection | undefined): string[] {
  return (selection?.indices ?? [])
    .map((index) => question.options[index]?.label ?? '')
    .filter((label) => label.length > 0)
}

function isAnswered(selection: AskAnswerSelection | undefined): boolean {
  return (selection?.indices.length ?? 0) > 0 || singleLine(selection?.other ?? '').length > 0
}

/** Droid's own advance: the next question (cyclic) that still has no answer. */
function nextUnanswered(current: number, total: number, answered: ReadonlySet<number>): number {
  for (let step = 1; step <= total; step += 1) {
    const candidate = (current + step) % total
    if (!answered.has(candidate)) {
      return candidate
    }
  }
  return current
}

export function buildDroidAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const questions = prompt.questions
  const total = questions.length
  const groups: AskAnswerKeyGroup[] = []
  const answered = new Set<number>()
  let cursor = 0

  questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    if (!isAnswered(selection)) {
      return
    }
    // Tab walks questions without committing anything. Only a multi-select with
    // a pending answer submits on Tab, and this never leaves one in that state.
    for (let step = 0; step < (questionIndex - cursor + total) % total; step += 1) {
      groups.push({ raw: TAB })
    }
    cursor = questionIndex
    const other = singleLine(selection?.other ?? '')

    if (question.multiSelect) {
      let row = 0
      for (const index of [...(selection?.indices ?? [])].sort((left, right) => left - right)) {
        for (let step = row; step < index; step += 1) {
          groups.push({ raw: DOWN })
        }
        row = index
        groups.push({ raw: ENTER })
      }
      if (other) {
        // A printable input opens text entry from wherever the highlight sits;
        // Enter then parks on Continue, which the second Enter submits.
        groups.push({ text: other }, { raw: ENTER }, { raw: ENTER })
      } else {
        groups.push({ raw: RIGHT })
      }
    } else if (other) {
      // Single-select carries one value, so a free-text answer absorbs any
      // picked labels rather than being dropped.
      groups.push({ text: [...pickedLabels(question, selection), other].join(', ') })
      groups.push({ raw: ENTER })
    } else {
      for (let step = 0; step < selection!.indices[0]!; step += 1) {
        groups.push({ raw: DOWN })
      }
      groups.push({ raw: ENTER })
    }

    answered.add(questionIndex)
    cursor = nextUnanswered(questionIndex, total, answered)
  })

  return groups
}
