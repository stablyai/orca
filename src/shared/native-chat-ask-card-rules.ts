import type { AgentJournalFreeTextInput } from './agent-session-journal-types'
import type { AskQuestion } from './native-chat-ask-types'

// How a stepped question card picks, labels and confirms; desktop and mobile draw it differently.

/** Multi-select keeps picks in option order so the answer reads as the options do. */
export function toggleAskOption(
  picked: readonly number[],
  optionIndex: number,
  multiSelect: boolean
): number[] {
  if (picked.includes(optionIndex)) {
    return picked.filter((index) => index !== optionIndex)
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

export function askConfirmLabel(
  currentAnswered: boolean,
  isLast: boolean
): 'submit' | 'next' | 'skip' {
  if (!currentAnswered) {
    return 'skip'
  }
  return isLast ? 'submit' : 'next'
}
