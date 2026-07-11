import type { XtermBypassEvent } from './xterm-bypass-policy'

type TerminalImeLinuxCandidateState = {
  classifyKeyboardEvent: (event: XtermBypassEvent) => { candidateDigitGuardActive: boolean }
  observeKeyboardEvent: (
    event: XtermBypassEvent,
    classification: { candidateDigitGuardActive: boolean }
  ) => void
}

const ORPHAN_LETTER_KEYDOWN_MAX_AGE_MS = 1000
const CANDIDATE_DIGIT_WINDOW_MS = 1500
const ASCII_LOWERCASE_LETTER = /^[a-z]$/
const ASCII_DIGIT = /^[0-9]$/

function isPlainAsciiLetterKey(event: XtermBypassEvent): boolean {
  return (
    ASCII_LOWERCASE_LETTER.test(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

function isPlainAsciiDigitKey(event: XtermBypassEvent): boolean {
  return (
    ASCII_DIGIT.test(event.key) &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  )
}

export function createTerminalImeLinuxCandidateState(
  now: () => number = () => Date.now()
): TerminalImeLinuxCandidateState {
  const pendingPlainLetterKeydownsByCode = new Map<string, number>()
  let candidateDigitUntil = 0

  return {
    classifyKeyboardEvent: (event) => {
      const at = now()
      return {
        candidateDigitGuardActive:
          event.type === 'keydown' && isPlainAsciiDigitKey(event) && candidateDigitUntil > at
      }
    },
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
