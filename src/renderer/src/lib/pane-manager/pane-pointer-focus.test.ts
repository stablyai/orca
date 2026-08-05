import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isInsideFocusOwnedPane,
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

describe('isInsideFocusOwnedPane', () => {
  function fakeCandidate(paneHasMatch: boolean | null): Element {
    const pane =
      paneHasMatch === null
        ? null
        : ({ querySelector: vi.fn(() => (paneHasMatch ? {} : null)) } as unknown as HTMLElement)
    return { closest: vi.fn(() => pane) } as unknown as Element
  }

  it('is false when the candidate has no .pane ancestor', () => {
    expect(isInsideFocusOwnedPane(fakeCandidate(null))).toBe(false)
  })

  it('is false when the ancestor pane has no focus-owning app control', () => {
    expect(isInsideFocusOwnedPane(fakeCandidate(false))).toBe(false)
  })

  it('is true when the ancestor pane hosts a focus-owning app control', () => {
    expect(isInsideFocusOwnedPane(fakeCandidate(true))).toBe(true)
  })
})
