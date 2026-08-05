import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  paneContainerOwnsFocus,
  shouldFocusTerminalFromPanePointerDown
} from './pane-pointer-focus'

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

describe('paneContainerOwnsFocus', () => {
  function fakeContainer(hasMatch: boolean): HTMLElement {
    return {
      querySelector: vi.fn(() => (hasMatch ? {} : null))
    } as unknown as HTMLElement
  }

  it('is false for an ordinary terminal pane container', () => {
    expect(paneContainerOwnsFocus(fakeContainer(false))).toBe(false)
  })

  it('is true when the pane hosts a focus-owning app control (e.g. the native chat composer)', () => {
    expect(paneContainerOwnsFocus(fakeContainer(true))).toBe(true)
  })
})
