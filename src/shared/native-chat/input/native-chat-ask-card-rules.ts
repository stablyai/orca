import type { AgentJournalFreeTextInput } from '../../agent-session/journal/agent-session-journal-types'
import type { AskQuestion } from './native-chat-ask-types'

// How a stepped question card picks, labels and confirms; desktop and mobile draw it differently.

/** A single-select whose pick reveals a preview: picking only selects, and the user confirms. */
export function askQuestionShowsPreviews(
  question: { multiSelect: boolean; options: readonly { preview?: string }[] } | undefined
): boolean {
  return question !== undefined && !question.multiSelect && question.options.some((o) => o.preview)
}

/** Multi-select keeps picks in option order so the answer reads as the options do. `keepChosen`:
 * picking the chosen option again keeps it, as a preview question's pick does. */
export function toggleAskOption(
  picked: readonly number[],
  optionIndex: number,
  multiSelect: boolean,
  keepChosen = false
): number[] {
  if (picked.includes(optionIndex)) {
    return keepChosen ? [...picked] : picked.filter((index) => index !== optionIndex)
  }
  return multiSelect ? [...picked, optionIndex].sort((a, b) => a - b) : [optionIndex]
}

/** Free text is kept verbatim only where the provider accepts an empty or spaced answer. */
export function askTypedText(raw: string, input: AgentJournalFreeTextInput | undefined): string {
  return input?.allowEmpty ? raw : raw.trim()
}

/** A typing-only question whose provider takes an empty answer counts as answered. */
export function askAcceptsEmptyAnswer(
  question: AskQuestion | undefined,
  input: AgentJournalFreeTextInput | undefined
): boolean {
  return input?.allowEmpty === true && question?.options.length === 0
}

/** Proceed advances, or submits on the last question; an empty final Skip dismisses, while empty Enter keeps the prompt. */
export function askConfirmAction(args: {
  isLast: boolean
  anyAnswered: boolean
  fromKeyboard?: boolean
}): 'proceed' | 'cancel' | 'stay' {
  if (!args.isLast || args.anyAnswered) {
    return 'proceed'
  }
  return args.fromKeyboard ? 'stay' : 'cancel'
}

/** The last step says Submit whenever any answer will be sent, even if its own question was skipped. */
export function askConfirmLabel(
  currentAnswered: boolean,
  isLast: boolean,
  anyAnswered: boolean
): 'submit' | 'next' | 'skip' {
  if (isLast) {
    return anyAnswered ? 'submit' : 'skip'
  }
  return currentAnswered ? 'next' : 'skip'
}
