// @vitest-environment happy-dom
/**
 * A digit that terminates a Hangul composition must reach the pty (#15299: typing `아1` in the
 * integrated terminal on Wayland produces `아`).
 *
 * The Linux candidate-digit guards exist for Sogou/fcitx Pinyin, where a bare digit picks a
 * numbered candidate and must never be typed (#7543, #8241). Only the orphan-keyup guard is at
 * fault here: it arms off a lone letter keyup, cannot see which engine produced it, and spends
 * its one suppression on the key that ends a Korean syllable. The composition-window guards stay
 * as they are — ibus-hangul's Hanja lookup table does index candidates by digit, over a live
 * preedit those guards already own.
 *
 * The composition shape below follows the recorded ibus-hangul trace
 * (`__fixtures__/ibus-hangul-mixed-ascii-terminal-trace.json`): non-empty preedit updates, then
 * compositionend, then the commit's own `insertText`. Neither recording leaves an empty
 * compositionupdate standing before the digit, so the 250ms post-composition window never arms
 * for this bug and no test may lean on it.
 */
import { describe, expect, it } from 'vitest'
import {
  installTerminalImeCompositionTracker,
  TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS,
  type TerminalImeCompositionTracker
} from './terminal-ime-composition-tracker'
import { createTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import {
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent,
  type XtermImeKeyboardOptions
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

type ImeHarness = {
  tracker: TerminalImeCompositionTracker
  element: HTMLElement
  candidateState: ReturnType<typeof createTerminalImeLinuxCandidateState>
  advance: (ms: number) => void
  dispose: () => void
}

function installImeHarness(): ImeHarness {
  let time = 1_000
  const element = document.createElement('div')
  document.body.appendChild(element)
  const tracker = installTerminalImeCompositionTracker(element, { now: () => time })
  return {
    tracker,
    element,
    candidateState: createTerminalImeLinuxCandidateState(() => time),
    advance: (ms) => {
      time += ms
    },
    dispose: () => {
      tracker.dispose()
      element.remove()
    }
  }
}

function dispatchComposition(element: HTMLElement, type: string, data: string): void {
  const composition = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(composition, 'data', { value: data })
  element.dispatchEvent(composition)
}

function dispatchInput(element: HTMLElement, inputType: string, data: string | null): void {
  const input = new InputEvent('input', { bubbles: true })
  Object.defineProperty(input, 'inputType', { value: inputType })
  Object.defineProperty(input, 'data', { value: data })
  element.dispatchEvent(input)
}

/** Drives a Hangul syllable into the tracker the way the recorded ibus trace reports one. */
function composeHangulSyllable(element: HTMLElement): void {
  dispatchComposition(element, 'compositionstart', '')
  dispatchComposition(element, 'compositionupdate', '아')
  dispatchInput(element, 'insertCompositionText', '아')
  dispatchComposition(element, 'compositionend', '아')
  dispatchInput(element, 'insertText', '아')
}

/**
 * Arms the #8241 orphan-digit window the way the Wayland input-method grab does: it swallows the
 * jamo keydown, so only the release reaches the page and reads as a legacy single-letter commit.
 */
function armOrphanCandidateDigitWindow(harness: ImeHarness): void {
  const jamoKeyup = event({ type: 'keyup', key: 'k', code: 'KeyK', keyCode: 75 })
  harness.candidateState.observeKeyboardEvent(
    jamoKeyup,
    harness.candidateState.classifyKeyboardEvent(jamoKeyup)
  )
}

const digitKeydown = event({ type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 })

/** The gate as `use-terminal-pane-lifecycle` assembles it for a Linux pane. */
function imeKeyboardOptions(harness: ImeHarness): XtermImeKeyboardOptions {
  return {
    compositionActive: harness.tracker.isActive(),
    candidateKeyGuardActive: harness.tracker.isCandidateKeyGuardActive(),
    pendingCandidateKeyReleaseActive: false,
    linuxOrphanCandidateDigitGuardActive:
      harness.candidateState.classifyKeyboardEvent(digitKeydown).candidateDigitGuardActive,
    hangulPreedit: harness.tracker.isHangulPreedit(),
    isMac: false,
    isLinux: true
  }
}

function suppressesDigit(harness: ImeHarness): boolean {
  return shouldSuppressTerminalImeKeyboardEvent(digitKeydown, imeKeyboardOptions(harness))
}

describe('a digit that terminates a Hangul composition', () => {
  it('survives the orphan-keyup window a compositor-grabbed Hangul keypress opens', () => {
    const harness = installImeHarness()
    composeHangulSyllable(harness.element)

    // The bug is exclusively after the commit, on the orphan path: no composition window is open.
    expect(harness.tracker.isActive()).toBe(false)
    expect(harness.tracker.isCandidateKeyGuardActive()).toBe(false)

    armOrphanCandidateDigitWindow(harness)
    harness.advance(120)

    // The orphan window still arms — it cannot see the composition. The policy is what declines
    // to spend it on a digit that a Hangul preedit has already claimed as literal text.
    expect(imeKeyboardOptions(harness).linuxOrphanCandidateDigitGuardActive).toBe(true)
    expect(suppressesDigit(harness)).toBe(false)
    expect(
      shouldPreventDefaultTerminalImeCandidateKey(digitKeydown, imeKeyboardOptions(harness))
    ).toBe(false)

    harness.dispose()
  })

  it("stays literal across the commit's own insertText", () => {
    const harness = installImeHarness()
    composeHangulSyllable(harness.element)

    // Both recordings deliver `insertText` for the committed syllable; on Wayland the digit can
    // follow it, so the commit must not be read as "ordinary typing resumed".
    expect(harness.tracker.isHangulPreedit()).toBe(true)

    harness.dispose()
  })

  it('keeps the digit IME-owned while the Hangul preedit is still live', () => {
    const harness = installImeHarness()
    dispatchComposition(harness.element, 'compositionstart', '')
    dispatchComposition(harness.element, 'compositionupdate', '아')
    dispatchInput(harness.element, 'insertCompositionText', '아')

    // ibus-hangul's Hanja conversion (Hanja key / F9) puts a numbered lookup table over a live
    // Hangul preedit and its symbol table behaves the same, so digits are selectors there.
    expect(harness.tracker.isHangulPreedit()).toBe(true)
    expect(suppressesDigit(harness)).toBe(true)

    harness.dispose()
  })

  it('stops claiming digits once the Hangul preedit has gone stale', () => {
    const harness = installImeHarness()
    composeHangulSyllable(harness.element)

    // Switching engine (Hangul -> Pinyin) moves no DOM focus, and the #8241 orphan path emits no
    // composition or input events at all, so only expiry can retire the Hangul classification.
    harness.advance(TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS + 1)
    armOrphanCandidateDigitWindow(harness)

    expect(harness.tracker.isHangulPreedit()).toBe(false)
    expect(suppressesDigit(harness)).toBe(true)

    harness.dispose()
  })

  it('re-reads the preedit script when the next composition starts', () => {
    const harness = installImeHarness()
    composeHangulSyllable(harness.element)
    dispatchComposition(harness.element, 'compositionstart', '')

    // compositionstart carries no data, so the classification cannot survive into a session that
    // may belong to another engine; the following compositionupdate re-establishes it.
    expect(harness.tracker.isHangulPreedit()).toBe(false)

    harness.dispose()
  })

  it('still lets a Pinyin preedit claim its numbered candidate digit', () => {
    const harness = installImeHarness()

    // Sogou/fcitx Pinyin picks candidates by digit over a Latin preedit (#7543/#8241), and
    // delivers the selector as a plain keydown. That must stay IME-owned.
    dispatchComposition(harness.element, 'compositionstart', '')
    dispatchComposition(harness.element, 'compositionupdate', 'nihao')
    dispatchInput(harness.element, 'insertCompositionText', 'nihao')

    expect(harness.tracker.isHangulPreedit()).toBe(false)
    expect(suppressesDigit(harness)).toBe(true)

    harness.dispose()
  })
})
