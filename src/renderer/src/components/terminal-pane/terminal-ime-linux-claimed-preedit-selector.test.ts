import { describe, expect, it } from 'vitest'
import { createTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import {
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent,
  type XtermBypassEvent,
  type XtermImeKeyboardOptions
} from './xterm-bypass-policy'

/**
 * Sogou on fcitx draws its preedit and candidate list in its own window and opens no Chromium
 * composition session, so every composition-scoped guard is idle when the user presses Space or a
 * candidate digit. The selector then reached the PTY as literal text while the commit arrived
 * afterwards — a space or a digit in front of every phrase (#22442).
 */
function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

/** The keydown shape fcitx delivers for a letter it has claimed for a preedit. */
function claimedLetterKeydown(code: string): XtermBypassEvent {
  return event({ key: 'Process', code, keyCode: 229 })
}

function linuxOptions(overrides: Partial<XtermImeKeyboardOptions> = {}): XtermImeKeyboardOptions {
  return {
    compositionActive: false,
    candidateKeyGuardActive: false,
    pendingCandidateKeyReleaseActive: false,
    isMac: false,
    isLinux: true,
    ...overrides
  }
}

/** Feeds the state one event and returns its classification. */
function observe(
  state: ReturnType<typeof createTerminalImeLinuxCandidateState>,
  keyboardEvent: XtermBypassEvent
): { imeOwnedPreeditGuardActive: boolean; candidateDigitGuardActive: boolean } {
  const classification = state.classifyKeyboardEvent(keyboardEvent)
  state.observeKeyboardEvent(keyboardEvent, classification)
  return classification
}

describe('claimed-preedit candidate selectors on Linux', () => {
  it('claims Space and a candidate digit after the IME claims the letter keydowns', () => {
    for (const selector of [
      event({ key: ' ', code: 'Space', keyCode: 32 }),
      event({ key: '3', code: 'Digit3', keyCode: 51 })
    ]) {
      let time = 1_000
      const state = createTerminalImeLinuxCandidateState(() => time)
      observe(state, claimedLetterKeydown('KeyN'))
      observe(state, event({ type: 'keyup', key: 'n', code: 'KeyN', keyCode: 78 }))
      time += 40

      const classification = state.classifyKeyboardEvent(selector)
      expect(classification.imeOwnedPreeditGuardActive).toBe(true)

      const options = linuxOptions({ linuxImeOwnedPreeditGuardActive: true })
      expect(shouldSuppressTerminalImeKeyboardEvent(selector, options)).toBe(true)
      // Returning false from the custom handler does not preventDefault, so the
      // selector would still reach the helper textarea and be flushed later.
      expect(shouldPreventDefaultTerminalImeCandidateKey(selector, options)).toBe(true)
    }
  })

  it('claims only one selector per claimed preedit', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, claimedLetterKeydown('KeyN'))
    time += 40
    expect(
      observe(state, event({ key: ' ', code: 'Space', keyCode: 32 })).imeOwnedPreeditGuardActive
    ).toBe(true)
    time += 40
    expect(
      state.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
        .imeOwnedPreeditGuardActive
    ).toBe(false)
  })

  // Chromium preserves the original `code` on the 229/Process keydown the IME
  // consumed, so the keys that edit and page a preedit arrive claimed too.
  it.each([
    ['Backspace', 'Backspace'],
    ['candidate navigation', 'ArrowDown'],
    ['next candidate page', 'Equal'],
    ['previous candidate page', 'Minus'],
    ['page down', 'PageDown']
  ])('keeps the window open across a claimed %s keydown', (_label, code) => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, claimedLetterKeydown('KeyN'))
    time += 40
    observe(state, event({ key: 'Process', code, keyCode: 229 }))
    time += 40
    expect(
      state.classifyKeyboardEvent(event({ key: '2', code: 'Digit2', keyCode: 50 }))
        .imeOwnedPreeditGuardActive
    ).toBe(true)
  })

  it('refreshes the deadline while the IME keeps claiming keys, without arming from cold', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, claimedLetterKeydown('KeyN'))
    // Browsing candidate pages for longer than one window still picks correctly.
    for (let page = 0; page < 3; page += 1) {
      time += 1_000
      observe(state, event({ key: 'Process', code: 'Equal', keyCode: 229 }))
    }
    time += 40
    expect(
      state.classifyKeyboardEvent(event({ key: '2', code: 'Digit2', keyCode: 50 }))
        .imeOwnedPreeditGuardActive
    ).toBe(true)

    // A claimed navigation key on its own is not evidence of an open preedit.
    const cold = createTerminalImeLinuxCandidateState(() => time)
    observe(cold, event({ key: 'Process', code: 'ArrowDown', keyCode: 229 }))
    time += 40
    expect(
      cold.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
        .imeOwnedPreeditGuardActive
    ).toBe(false)
  })

  it('leaves ordinary Latin typing alone', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    for (const [key, code, keyCode] of [
      ['l', 'KeyL', 76],
      ['s', 'KeyS', 83]
    ] as const) {
      observe(state, event({ key, code, keyCode }))
      observe(state, event({ type: 'keyup', key, code, keyCode }))
      time += 20
    }
    for (const selector of [
      event({ key: ' ', code: 'Space', keyCode: 32 }),
      event({ key: '7', code: 'Digit7', keyCode: 55 })
    ]) {
      expect(state.classifyKeyboardEvent(selector).imeOwnedPreeditGuardActive).toBe(false)
    }
  })

  it('releases the window once the picking round is over', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, claimedLetterKeydown('KeyM'))
    state.resetImeOwnedPreeditGuard()
    time += 40
    expect(
      state.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
        .imeOwnedPreeditGuardActive
    ).toBe(false)
  })

  it('expires the window rather than holding Space hostage', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, claimedLetterKeydown('KeyM'))
    time += 1_600
    expect(
      state.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
        .imeOwnedPreeditGuardActive
    ).toBe(false)
  })

  it('leaves a Hangul syllable its terminating Space and digit', () => {
    const options = linuxOptions({
      linuxImeOwnedPreeditGuardActive: true,
      hangulPreedit: true
    })
    for (const selector of [
      event({ key: ' ', code: 'Space', keyCode: 32 }),
      event({ key: '3', code: 'Digit3', keyCode: 51 })
    ]) {
      expect(shouldSuppressTerminalImeKeyboardEvent(selector, options)).toBe(false)
    }
  })

  it('does not claim modified or non-Linux selectors', () => {
    const selector = event({ key: ' ', code: 'Space', keyCode: 32, ctrlKey: true })
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        selector,
        linuxOptions({ linuxImeOwnedPreeditGuardActive: true })
      )
    ).toBe(false)
    const plainSpace = event({ key: ' ', code: 'Space', keyCode: 32 })
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        plainSpace,
        linuxOptions({ isLinux: false, isMac: true, linuxImeOwnedPreeditGuardActive: true })
      )
    ).toBe(false)
  })

  it('does not arm from a control chord the IME never claimed', () => {
    let time = 1_000
    const state = createTerminalImeLinuxCandidateState(() => time)
    observe(state, event({ key: 'Process', code: 'KeyN', keyCode: 229, ctrlKey: true }))
    time += 40
    expect(
      state.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
        .imeOwnedPreeditGuardActive
    ).toBe(false)
  })
})
