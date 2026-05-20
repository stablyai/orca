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
