// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { installTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import type { XtermBypassEvent } from './xterm-bypass-policy'

/**
 * The sibling selector suite drives the state object directly, so it cannot see a
 * missing listener. These drive the installed DOM wiring.
 *
 * `compositionend` matters on its own: an engine that DOES run a composition
 * session still emits the claimed `keyCode 229` keydowns that arm this window,
 * and both its commit and its cancel travel as `insertCompositionText`, which the
 * commit release deliberately ignores. Without a release at the session's end the
 * window outlived a cancelled preedit and swallowed the next literal Space.
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

function installOnElement(): {
  element: HTMLElement
  state: ReturnType<typeof installTerminalImeLinuxCandidateState>
  advance: (ms: number) => void
} {
  const element = document.createElement('div')
  let time = 1_000
  const state = installTerminalImeLinuxCandidateState(element, () => time, element)
  return { element, state, advance: (ms) => void (time += ms) }
}

function armWithClaimedLetter(
  state: ReturnType<typeof installTerminalImeLinuxCandidateState>
): void {
  const keydown = event({ key: 'Process', code: 'KeyN', keyCode: 229 })
  state.observeKeyboardEvent(keydown, state.classifyKeyboardEvent(keydown))
}

function claimsSpace(state: ReturnType<typeof installTerminalImeLinuxCandidateState>): boolean {
  return state.classifyKeyboardEvent(event({ key: ' ', code: 'Space', keyCode: 32 }))
    .imeOwnedPreeditGuardActive
}

describe('claimed-preedit window release wiring', () => {
  it.each(['compositionstart', 'compositionend'])('releases the window on %s', (eventType) => {
    const { element, state, advance } = installOnElement()
    armWithClaimedLetter(state)
    advance(40)
    expect(claimsSpace(state)).toBe(true)
    element.dispatchEvent(new CompositionEvent(eventType, { data: '你' }))
    expect(claimsSpace(state)).toBe(false)
    state.dispose()
  })

  it('releases the window on a commit that is not preedit text', () => {
    const { element, state, advance } = installOnElement()
    armWithClaimedLetter(state)
    advance(40)
    element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '你' }))
    expect(claimsSpace(state)).toBe(false)
    state.dispose()
  })

  it('keeps the window across a preedit-text input event', () => {
    const { element, state, advance } = installOnElement()
    armWithClaimedLetter(state)
    advance(40)
    element.dispatchEvent(
      new InputEvent('input', { inputType: 'insertCompositionText', data: 'ni' })
    )
    expect(claimsSpace(state)).toBe(true)
    state.dispose()
  })

  it('stops listening once disposed', () => {
    const { element, state, advance } = installOnElement()
    state.dispose()
    armWithClaimedLetter(state)
    advance(40)
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }))
    expect(claimsSpace(state)).toBe(true)
  })
})

/**
 * The full session shape for a Pinyin/Mozc/Anthy/Zhuyin engine that commits on
 * Space: every letter after the first re-arms the window, the commit travels as
 * preedit text, and the committing Space itself arrives claimed. Only the end of
 * the session can close the window before the user's next literal Space.
 */
describe('a composition session that commits on Space', () => {
  it('leaves the following literal Space alone', () => {
    const { element, state, advance } = installOnElement()
    const feed = (keyboardEvent: XtermBypassEvent): boolean => {
      const classification = state.classifyKeyboardEvent(keyboardEvent)
      state.observeKeyboardEvent(keyboardEvent, classification)
      return classification.imeOwnedPreeditGuardActive
    }

    feed(event({ key: 'Process', code: 'KeyN', keyCode: 229 }))
    element.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    advance(40)
    // A second claimed letter re-arms; there is no second compositionstart.
    feed(event({ key: 'Process', code: 'KeyI', keyCode: 229 }))
    element.dispatchEvent(
      new InputEvent('input', { inputType: 'insertCompositionText', data: 'ni' })
    )
    advance(40)

    // The committing Space is claimed by the engine, so it never reaches the guard.
    expect(feed(event({ key: 'Process', code: 'Space', keyCode: 229 }))).toBe(false)
    element.dispatchEvent(
      new InputEvent('input', { inputType: 'insertCompositionText', data: '你' })
    )
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }))
    advance(40)

    expect(claimsSpace(state)).toBe(false)
    state.dispose()
  })
})

/**
 * Belt and braces for an engine that opens a composition session and never closes
 * it — a documented defect in at least one shipped input framework. Without a
 * `compositionend` the session-end release never runs, so the claimed selector
 * itself has to end the window.
 */
describe('a composition session that never ends', () => {
  it.each(['Space', 'Enter', 'NumpadEnter', 'Escape', 'Digit2', 'Numpad2'])(
    'still frees the next literal Space after a claimed %s',
    (selectorCode) => {
      const { element, state, advance } = installOnElement()
      const feed = (keyboardEvent: XtermBypassEvent): void => {
        state.observeKeyboardEvent(keyboardEvent, state.classifyKeyboardEvent(keyboardEvent))
      }

      feed(event({ key: 'Process', code: 'KeyN', keyCode: 229 }))
      element.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
      advance(40)
      feed(event({ key: 'Process', code: 'KeyI', keyCode: 229 }))
      element.dispatchEvent(
        new InputEvent('input', { inputType: 'insertCompositionText', data: 'ni' })
      )
      advance(40)
      feed(event({ key: 'Process', code: selectorCode, keyCode: 229 }))
      element.dispatchEvent(
        new InputEvent('input', { inputType: 'insertCompositionText', data: '你' })
      )
      // No compositionend arrives.
      advance(40)

      expect(claimsSpace(state)).toBe(false)
      state.dispose()
    }
  )

  it('still lets the IME page its candidate list', () => {
    const { element, state, advance } = installOnElement()
    const feed = (keyboardEvent: XtermBypassEvent): void => {
      state.observeKeyboardEvent(keyboardEvent, state.classifyKeyboardEvent(keyboardEvent))
    }
    feed(event({ key: 'Process', code: 'KeyN', keyCode: 229 }))
    advance(40)
    feed(event({ key: 'Process', code: 'Equal', keyCode: 229 }))
    advance(40)
    expect(claimsSpace(state)).toBe(true)
    state.dispose()
    element.remove()
  })
})
