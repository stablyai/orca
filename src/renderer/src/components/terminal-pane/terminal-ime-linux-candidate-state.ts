import type { XtermBypassEvent } from './xterm-bypass-policy'
import { isTerminalImeCandidateSelectionKeyEvent } from './terminal-ime-candidate-key-release-guard'

export type TerminalImeLinuxCandidateClassification = {
  candidateDigitGuardActive: boolean
  /** True for a selector the IME owns because it is still picking a preedit it
   *  never opened a composition session for. */
  imeOwnedPreeditGuardActive: boolean
}

type TerminalImeLinuxCandidateState = {
  /** Classifies an event before the state observes it. */
  classifyKeyboardEvent: (event: XtermBypassEvent) => TerminalImeLinuxCandidateClassification
  /** Advances the state after the caller consumes an event classification. */
  observeKeyboardEvent: (
    event: XtermBypassEvent,
    classification: TerminalImeLinuxCandidateClassification
  ) => void
  /** Drops all candidate and physical-key state. */
  reset: () => void
  /** Drops only this pane's candidate window. */
  resetCandidateGuard: () => void
  /** Drops only the window armed by IME-claimed letter keydowns. */
  resetImeOwnedPreeditGuard: () => void
}

type TerminalImeLinuxPhysicalKeyTracker = {
  pressedCodes: Set<string>
  dispose: () => void
}

const CANDIDATE_DIGIT_WINDOW_MS = 1500
// A stuck-state valve, not an attribution window: every normal path out of a
// pick is event-driven — the session's start or end, a non-preedit commit, a
// claimed commit or cancel key, an unclaimed key, or blur. Claimed keys refresh
// it, so this only expires when the IME stops reporting entirely.
const IME_OWNED_PREEDIT_WINDOW_MS = 1500
const ASCII_LOWERCASE_LETTER = /^[a-z]$/
const ASCII_DIGIT = /^[0-9]$/
const PHYSICAL_ASCII_LETTER_CODE = /^Key[A-Z]$/
// Why these and not the navigation keys: an engine commits or cancels with
// Space, Enter or Escape and pages with the arrows, `-`/`=` and PageUp/PageDown.
// Physical codes rather than `key`, because `key` reads `Process` on all of them
// and because the digit row moves on AZERTY, Dvorak and Colemak while `Digit*`
// does not.
const PHYSICAL_PICK_ENDING_CODE = /^(?:Space|Enter|NumpadEnter|Escape|Digit[0-9]|Numpad[0-9])$/
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
  // Why: bubble-phase keyup cleanup runs after xterm's target handler, so the
  // pane can still classify that release against the shared pressed-key set.
  // Why no 'blur' reset: clearing held keys on focus loss makes a letter held
  // across a focus change look like an orphaned legacy-IME keyup on release,
  // which would wrongly arm the candidate-digit guard and drop the user's next
  // bare digit. Keeping the keydown record lets that release match instead. A
  // key released while the window is unfocused lingers until its next press,
  // which only softens the orphan heuristic — it never suppresses real input.
  eventTarget.addEventListener('keydown', observeKeyboardEvent)
  eventTarget.addEventListener('keyup', observeKeyboardEvent)
  const tracker = {
    pressedCodes,
    users: 1,
    dispose: () => releasePhysicalKeyTracker(eventTarget, tracker),
    observeKeyboardEvent
  }
  physicalKeyTrackers.set(eventTarget, tracker)
  return tracker
}

function releasePhysicalKeyTracker(
  eventTarget: EventTarget,
  tracker: TerminalImeLinuxPhysicalKeyTracker & {
    users: number
    observeKeyboardEvent?: EventListener
  }
): void {
  tracker.users -= 1
  if (tracker.users > 0) {
    return
  }
  if (tracker.observeKeyboardEvent) {
    eventTarget.removeEventListener('keydown', tracker.observeKeyboardEvent)
    eventTarget.removeEventListener('keyup', tracker.observeKeyboardEvent)
  }
  tracker.pressedCodes.clear()
  physicalKeyTrackers.delete(eventTarget)
}

/**
 * A keydown the input framework has already claimed.
 *
 * Why this is the signal: Sogou on fcitx draws its preedit and candidate list in
 * its own window and opens no Chromium composition session at all, so every
 * composition-scoped guard is inactive when the user presses the selector. What
 * it does still deliver is the claimed keydown — `keyCode 229` / `key 'Process'`
 * over the original physical key — and that is positive evidence that some
 * preedit the renderer cannot see is open. fcitx5 on Wayland omits the marker
 * instead, which is why this complements the orphan-keyup window rather than
 * replacing it.
 */
function isImeClaimedKeydown(event: XtermBypassEvent): boolean {
  return (
    event.type === 'keydown' &&
    (event.keyCode === 229 || event.key === 'Process') &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  )
}

/** A claimed keydown over a letter, which is a preedit being spelled out. */
function isImeOwnedLetterKeydown(event: XtermBypassEvent): boolean {
  return (
    isImeClaimedKeydown(event) &&
    event.code !== undefined &&
    PHYSICAL_ASCII_LETTER_CODE.test(event.code)
  )
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
  pendingPlainLetterKeydownsByCode = new Set<string>()
): TerminalImeLinuxCandidateState {
  let candidateDigitUntil = 0
  let imeOwnedPreeditUntil = 0

  const resetCandidateGuard = (): void => {
    candidateDigitUntil = 0
    imeOwnedPreeditUntil = 0
  }

  const reset = (): void => {
    pendingPlainLetterKeydownsByCode.clear()
    resetCandidateGuard()
  }

  return {
    reset,
    resetCandidateGuard,
    resetImeOwnedPreeditGuard: () => {
      imeOwnedPreeditUntil = 0
    },
    /** Classifies the current event before state is advanced for it. */
    classifyKeyboardEvent: (event) => {
      const at = now()
      return {
        candidateDigitGuardActive:
          event.type === 'keydown' && isPlainAsciiDigitKey(event) && candidateDigitUntil > at,
        imeOwnedPreeditGuardActive:
          event.type === 'keydown' &&
          isTerminalImeCandidateSelectionKeyEvent(event) &&
          imeOwnedPreeditUntil > at
      }
    },
    /** Records the current event after its classification is consumed. */
    observeKeyboardEvent: (event, classification) => {
      const at = now()
      if (imeOwnedPreeditUntil <= at) {
        imeOwnedPreeditUntil = 0
      }
      if (classification.imeOwnedPreeditGuardActive) {
        // One selector per claimed preedit: the next letter the IME claims arms
        // the window again, so a stale window cannot eat later literal input.
        imeOwnedPreeditUntil = 0
        candidateDigitUntil = 0
        return
      }
      if (event.type === 'keydown') {
        if (isImeOwnedLetterKeydown(event)) {
          imeOwnedPreeditUntil = at + IME_OWNED_PREEDIT_WINDOW_MS
        } else if (isImeClaimedKeydown(event)) {
          // A claimed commit or cancel means the engine ended the round itself.
          // Ending the window here is what keeps a literal Space safe when an
          // engine opens a composition session and never closes it.
          imeOwnedPreeditUntil =
            event.code !== undefined && PHYSICAL_PICK_ENDING_CODE.test(event.code)
              ? 0
              : // Why refresh rather than arm: the IME also claims the keys that
                // edit and page the preedit — Backspace, the arrows, `-`/`=` for
                // the next candidate page. Treating those as unclaimed disarmed
                // the window mid-pick and let the following selector through,
                // but claiming them from cold would arm on a bare navigation key
                // with no preedit behind it.
                imeOwnedPreeditUntil > at
                ? at + IME_OWNED_PREEDIT_WINDOW_MS
                : imeOwnedPreeditUntil
        } else if (!isTerminalImeCandidateSelectionKeyEvent(event)) {
          imeOwnedPreeditUntil = 0
        }
      }
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
  // Why: an input source that does open a composition session is already owned
  // by the composition-scoped guards, so the claimed-keydown window must stand
  // down at both boundaries rather than claim the same selector twice.
  const releaseToCompositionSession = (): void => state.resetImeOwnedPreeditGuard()
  // Why: a commit that is not preedit text means the picking round is over and
  // the next Space or digit is literal terminal input again. A session-running
  // IME commits through `insertCompositionText` instead and is released by
  // `compositionend` below, so this stays narrow rather than matching every
  // input event.
  const releaseOnCommit = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      return
    }
    state.resetImeOwnedPreeditGuard()
  }
  terminalElement?.addEventListener('blur', state.resetCandidateGuard, true)
  terminalElement?.addEventListener('compositionstart', releaseToCompositionSession, true)
  // Why both ends of the session: the claimed keydowns an engine that DOES run a
  // composition session emits still arm this window, and its commit and its
  // cancel both travel as `insertCompositionText`, which `releaseOnCommit`
  // deliberately ignores. Without this the window outlived a cancelled preedit
  // and swallowed the next literal Space. The engines this guard exists for emit
  // no `compositionend` at all, so releasing here cannot reach them.
  terminalElement?.addEventListener('compositionend', releaseToCompositionSession, true)
  terminalElement?.addEventListener('input', releaseOnCommit, true)
  return {
    ...state,
    dispose: () => {
      terminalElement?.removeEventListener('blur', state.resetCandidateGuard, true)
      terminalElement?.removeEventListener('compositionstart', releaseToCompositionSession, true)
      terminalElement?.removeEventListener('compositionend', releaseToCompositionSession, true)
      terminalElement?.removeEventListener('input', releaseOnCommit, true)
      physicalKeyTracker.dispose()
    }
  }
}
