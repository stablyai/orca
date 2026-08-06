import type { XtermBypassEvent } from './xterm-bypass-policy'

type TerminalImeLinuxCandidateState = {
  /** Classifies an event before the state observes it. */
  classifyKeyboardEvent: (event: XtermBypassEvent) => { candidateDigitGuardActive: boolean }
  /** Advances the state after the caller consumes an event classification. */
  observeKeyboardEvent: (
    event: XtermBypassEvent,
    classification: { candidateDigitGuardActive: boolean }
  ) => void
  /** Drops all candidate and physical-key state. */
  reset: () => void
  /** Drops only this pane's candidate window. */
  resetCandidateGuard: () => void
}

type TerminalImeLinuxPhysicalKeyTracker = {
  pressedCodes: Set<string>
  dispose: () => void
}

const CANDIDATE_DIGIT_WINDOW_MS = 1500
const ASCII_LOWERCASE_LETTER = /^[a-z]$/
const ASCII_DIGIT = /^[0-9]$/
const PHYSICAL_ASCII_LETTER_CODE = /^Key[A-Z]$/
const physicalKeyTrackers = new WeakMap<
  EventTarget,
  TerminalImeLinuxPhysicalKeyTracker & { users: number }
>()

function acquirePhysicalKeyTracker(
  eventTarget: EventTarget | null
): TerminalImeLinuxPhysicalKeyTracker {
  if (!eventTarget) {
    return { pressedCodes: new Set(), dispose: () => undefined }
  }
  const existing = physicalKeyTrackers.get(eventTarget)
  if (existing) {
    existing.users += 1
    return {
      pressedCodes: existing.pressedCodes,
      dispose: () => releasePhysicalKeyTracker(eventTarget, existing)
    }
  }

  const pressedCodes = new Set<string>()
  const observeKeyboardEvent = (event: Event): void => {
    const code = (event as Event & { code?: string }).code
    if (!code || !PHYSICAL_ASCII_LETTER_CODE.test(code)) {
      return
    }
    if (event.type === 'keydown') {
      pressedCodes.add(code)
    } else {
      pressedCodes.delete(code)
    }
  }
  const reset = (): void => pressedCodes.clear()
  // Why: bubble-phase keyup cleanup runs after xterm's target handler, so the
  // pane can still classify that release against the shared pressed-key set.
  eventTarget.addEventListener('keydown', observeKeyboardEvent)
  eventTarget.addEventListener('keyup', observeKeyboardEvent)
  eventTarget.addEventListener('blur', reset)
  const tracker = {
    pressedCodes,
    users: 1,
    dispose: () => releasePhysicalKeyTracker(eventTarget, tracker),
    observeKeyboardEvent,
    reset
  }
  physicalKeyTrackers.set(eventTarget, tracker)
  return tracker
}

function releasePhysicalKeyTracker(
  eventTarget: EventTarget,
  tracker: TerminalImeLinuxPhysicalKeyTracker & {
    users: number
    observeKeyboardEvent?: EventListener
    reset?: EventListener
  }
): void {
  tracker.users -= 1
  if (tracker.users > 0) {
    return
  }
  if (tracker.observeKeyboardEvent && tracker.reset) {
    eventTarget.removeEventListener('keydown', tracker.observeKeyboardEvent)
    eventTarget.removeEventListener('keyup', tracker.observeKeyboardEvent)
    eventTarget.removeEventListener('blur', tracker.reset)
  }
  tracker.pressedCodes.clear()
  physicalKeyTrackers.delete(eventTarget)
}

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
  now: () => number = () => Date.now(),
  pendingPlainLetterKeydownsByCode: Set<string> = new Set()
): TerminalImeLinuxCandidateState {
  let candidateDigitUntil = 0

  const resetCandidateGuard = (): void => {
    candidateDigitUntil = 0
  }

  const reset = (): void => {
    pendingPlainLetterKeydownsByCode.clear()
    resetCandidateGuard()
  }

  return {
    reset,
    resetCandidateGuard,
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
        if (!isPlainAsciiDigitKey(event)) {
          candidateDigitUntil = 0
        }
        const physicalCode = event.code
        if (physicalCode && PHYSICAL_ASCII_LETTER_CODE.test(physicalCode)) {
          pendingPlainLetterKeydownsByCode.add(physicalCode)
        }
        return
      }

      if (event.type === 'keyup') {
        const matchingPlainLetterKeydown = event.code
          ? pendingPlainLetterKeydownsByCode.delete(event.code)
          : false
        if (isPlainAsciiLetterKey(event) && event.code) {
          if (!matchingPlainLetterKeydown) {
            // Why: some legacy Linux IME paths commit a single-letter preedit
            // without composition/input events. The orphaned keyup is a narrow
            // hint that the next bare digit belongs to the candidate picker.
            candidateDigitUntil = at + CANDIDATE_DIGIT_WINDOW_MS
          }
        }
      }
    }
  }
}

/** Installs Linux IME candidate state with focus-loss cleanup. */
export function installTerminalImeLinuxCandidateState(
  terminalElement: EventTarget | null | undefined,
  now: () => number = () => Date.now(),
  rendererKeyboardEventTarget: EventTarget | null = typeof window === 'undefined'
    ? (terminalElement ?? null)
    : window
): TerminalImeLinuxCandidateState & { dispose: () => void } {
  const physicalKeyTracker = acquirePhysicalKeyTracker(rendererKeyboardEventTarget)
  const state = createTerminalImeLinuxCandidateState(now, physicalKeyTracker.pressedCodes)
  terminalElement?.addEventListener('blur', state.resetCandidateGuard, true)
  return {
    ...state,
    dispose: () => {
      terminalElement?.removeEventListener('blur', state.resetCandidateGuard, true)
      physicalKeyTracker.dispose()
    }
  }
}
