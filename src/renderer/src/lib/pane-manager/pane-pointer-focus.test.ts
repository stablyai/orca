// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldFocusTerminalFromPanePointerDown } from './pane-pointer-focus'

class FakeElement {
  constructor(private readonly closestResult: FakeElement | null = null) {}

  closest(): FakeElement | null {
    return this.closestResult
  }
}

describe('shouldFocusTerminalFromPanePointerDown', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', FakeElement)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('focuses the terminal for non-element targets', () => {
    expect(shouldFocusTerminalFromPanePointerDown({} as EventTarget)).toBe(true)
  })

  it('focuses the terminal for ordinary pane surface clicks', () => {
    const target = new FakeElement()

    expect(shouldFocusTerminalFromPanePointerDown(target as unknown as Element)).toBe(true)
  })

  it('does not steal focus from pane-local controls', () => {
    const control = new FakeElement()
    const target = new FakeElement(control)

    expect(shouldFocusTerminalFromPanePointerDown(target as unknown as Element)).toBe(false)
  })
})

describe('shouldFocusTerminalFromPanePointerDown against real pane DOM', () => {
  /** The real pane DOM shape: an xterm instance with its hidden helper textarea,
   *  plus a sibling overlay portaled in beside it. `overlayAttributes` is where
   *  the `data-pane-prevent-terminal-focus` opt-out is applied or omitted. */
  function paneContainer(overlayAttributes: string): HTMLElement {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
      <div class="chat-overlay"${overlayAttributes}><p id="turn">Assistant turn text</p></div>
    `
    return container
  }

  it('leaves the terminal unfocused for text inside a pane-local overlay', () => {
    // Why: the native chat transcript is portaled into the pane container. Without
    // the opt-out the pane's pointerdown focuses the xterm helper textarea, which
    // drops the document selection and kills shift-click range extension.
    const container = paneContainer(' data-pane-prevent-terminal-focus=""')
    const turn = container.querySelector('#turn')

    expect(shouldFocusTerminalFromPanePointerDown(turn)).toBe(false)
  })

  it('still focuses the terminal for plain pane surface text', () => {
    const container = paneContainer('')
    const turn = container.querySelector('#turn')

    expect(shouldFocusTerminalFromPanePointerDown(turn)).toBe(true)
  })

  it('still focuses the terminal from the xterm helper textarea itself', () => {
    const container = paneContainer('')
    const helper = container.querySelector('.xterm-helper-textarea')

    expect(shouldFocusTerminalFromPanePointerDown(helper)).toBe(true)
  })
})
