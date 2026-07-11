import type { XtermBypassEvent } from './xterm-bypass-policy'

type TerminalImeLinuxCandidateState = {
  /** Classifies an event before the state observes it. */
  classifyKeyboardEvent: (event: XtermBypassEvent) => { candidateDigitGuardActive: boolean }
  /** Advances the state after the caller consumes an event classification. */
  observeKeyboardEvent: (
    event: XtermBypassEvent,
    classification: { candidateDigitGuardActive: boolean }
  ) => void
}

const ORPHAN_LETTER_KEYDOWN_MAX_AGE_MS = 1000
const CANDIDATE_DIGIT_WINDOW_MS = 1500
const ASCII_LOWERCASE_LETTER = /^[a-z]$/
const ASCII_DIGIT = /^[0-9]$/

/** Returns whether an event is an unmodified lowercase Latin letter. */
function isPlainAsciiLetterKey(event: XtermBypassEvent): boolean {
  return (
    ASCII_LOWERCASE_LETTER.test(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

/** Returns whether an event is an unmodified ASCII digit. */
function isPlainAsciiDigitKey(event: XtermBypassEvent): boolean {
  return (
    ASCII_DIGIT.test(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

/** Tracks legacy desktop Linux IME candidate-selection event sequences. */
export function createTerminalImeLinuxCandidateState(
  now: () => number = () => Date.now()
): TerminalImeLinuxCandidateState {
  const pendingPlainLetterKeydownsByCode = new Map<string, number>()
  let candidateDigitUntil = 0

  return {
    /** Classifies the current event before state is advanced for it. */
    classifyKeyboardEvent: (event) => {
      const at = now()
      return {
        candidateDigitGuardActive:
          event.type === 'keydown' && isPlainAsciiDigitKey(event) && candidateDigitUntil > at
      }
    },
    /** Records the current event after its classification is consumed. */
    observeKeyboardEvent: (event, classification) => {
      const at = now()
      if (classification.candidateDigitGuardActive) {
        candidateDigitUntil = 0
        return
      }

      if (candidateDigitUntil <= at) {
        candidateDigitUntil = 0
      }

      if (event.type === 'keydown') {
        if (isPlainAsciiLetterKey(event) && event.code) {
          pendingPlainLetterKeydownsByCode.set(event.code, at)
          return
        }
        if (!isPlainAsciiDigitKey(event)) {
          candidateDigitUntil = 0
        }
        return
      }

      if (event.type === 'keyup') {
        if (isPlainAsciiLetterKey(event) && event.code) {
          const pressedAt = pendingPlainLetterKeydownsByCode.get(event.code)
          const matchingPlainLetterKeydown =
            pressedAt !== undefined && at - pressedAt <= ORPHAN_LETTER_KEYDOWN_MAX_AGE_MS
          if (!matchingPlainLetterKeydown) {
            // Why: some legacy Linux IME paths commit a single-letter preedit
            // without composition/input events. The orphaned keyup is a narrow
            // hint that the next bare digit belongs to the candidate picker.
            candidateDigitUntil = at + CANDIDATE_DIGIT_WINDOW_MS
          }
          pendingPlainLetterKeydownsByCode.delete(event.code)
        }
      }
    }
  }
}
