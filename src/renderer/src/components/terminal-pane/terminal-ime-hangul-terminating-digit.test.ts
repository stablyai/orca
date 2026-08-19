// @vitest-environment happy-dom
/**
 * A digit that terminates a Hangul composition must reach the pty (#15299: typing `아1` in the
 * integrated terminal on Wayland produces `아`).
 *
 * The Linux candidate-digit guards exist for Sogou/fcitx Pinyin, where a bare digit picks a
 * numbered candidate and must never be typed (#7543, #8241). A Hangul engine has no numbered
 * candidate list at all — its preedit is a syllable being assembled, and a digit always ends it
 * and is literal text. Both guards key only off "an IME was recently involved", so once either
 * window is open they eat the digit regardless of which engine opened it.
 *
 * Each case below opens one of those windows the way a Hangul engine does, then types the digit.
 */
import { describe, expect, it } from 'vitest'
import {
  installTerminalImeCompositionTracker,
  type TerminalImeCompositionTracker
} from './terminal-ime-composition-tracker'
import { createTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import {
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

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

/** The gate as `use-terminal-pane-lifecycle` assembles it for a Linux pane. */
function suppressesDigit(
  tracker: TerminalImeCompositionTracker,
  orphanDigitGuardActive = false
): boolean {
  return shouldSuppressTerminalImeKeyboardEvent(
    event({ type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 }),
    {
      compositionActive: tracker.isActive(),
      candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
      pendingCandidateKeyReleaseActive: false,
      linuxOrphanCandidateDigitGuardActive: orphanDigitGuardActive,
      hangulPreedit: tracker.isHangulPreedit(),
      isMac: false,
      isLinux: true
    }
  )
}

/** Drives a Hangul syllable into the tracker the way ibus reports one. */
function composeHangulSyllable(terminalElement: HTMLElement): void {
  dispatchComposition(terminalElement, 'compositionstart', '')
  dispatchComposition(terminalElement, 'compositionupdate', '아')
  dispatchInput(terminalElement, 'insertCompositionText', '아')
  dispatchComposition(terminalElement, 'compositionupdate', '')
  dispatchComposition(terminalElement, 'compositionend', '아')
}

describe('a digit that terminates a Hangul composition', () => {
  it('survives the post-composition candidate window the ibus commit shape opens', () => {
    const terminalElement = document.createElement('div')
    document.body.appendChild(terminalElement)
    const tracker = installTerminalImeCompositionTracker(terminalElement)

    // ibus clears its preedit with an empty compositionupdate before committing, which is what
    // arms the post-compositionend window. Under X11 a trailing `insertText` disarms it again
    // (see the recorded ibus fixture); the Wayland ordering delivers the digit first.
    composeHangulSyllable(terminalElement)

    expect(tracker.isActive()).toBe(false)
    expect(suppressesDigit(tracker)).toBe(false)

    tracker.dispose()
    terminalElement.remove()
  })

  it('survives the orphan-keyup window a compositor-grabbed Hangul keypress opens', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    const terminalElement = document.createElement('div')
    document.body.appendChild(terminalElement)
    const tracker = installTerminalImeCompositionTracker(terminalElement)
    composeHangulSyllable(terminalElement)

    // The Wayland input method grabs the keyboard, so the jamo keydown never reaches the page;
    // only the release does. That lone keyup is what `terminal-ime-linux-candidate-state` reads
    // as "a legacy IME committed a single-letter preedit", arming the 1500ms digit window.
    const jamoKeyup = event({ type: 'keyup', key: 'k', code: 'KeyK', keyCode: 75 })
    state.observeKeyboardEvent(jamoKeyup, state.classifyKeyboardEvent(jamoKeyup))

    time += 120
    const digitKeydown = event({ type: 'keydown', key: '1', code: 'Digit1', keyCode: 49 })
    // The orphan window itself still arms — it cannot see the composition. The policy is what
    // declines to spend it on a digit that a Hangul preedit has already claimed as literal.
    expect(state.classifyKeyboardEvent(digitKeydown).candidateDigitGuardActive).toBe(true)
    expect(suppressesDigit(tracker, true)).toBe(false)
    expect(
      shouldPreventDefaultTerminalImeCandidateKey(digitKeydown, {
        compositionActive: tracker.isActive(),
        candidateKeyGuardActive: tracker.isCandidateKeyGuardActive(),
        pendingCandidateKeyReleaseActive: false,
        linuxOrphanCandidateDigitGuardActive: true,
        hangulPreedit: tracker.isHangulPreedit(),
        isMac: false,
        isLinux: true
      })
    ).toBe(false)

    tracker.dispose()
    terminalElement.remove()
  })

  it('still lets a Pinyin preedit claim its numbered candidate digit', () => {
    const terminalElement = document.createElement('div')
    document.body.appendChild(terminalElement)
    const tracker = installTerminalImeCompositionTracker(terminalElement)

    // Sogou/fcitx Pinyin picks candidates by digit over a Latin preedit (#7543/#8241), and
    // delivers the selector as a plain keydown. That must stay IME-owned.
    dispatchComposition(terminalElement, 'compositionstart', '')
    dispatchComposition(terminalElement, 'compositionupdate', 'nihao')
    dispatchInput(terminalElement, 'insertCompositionText', 'nihao')

    expect(tracker.isHangulPreedit()).toBe(false)
    expect(suppressesDigit(tracker)).toBe(true)

    tracker.dispose()
    terminalElement.remove()
  })
})
