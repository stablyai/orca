// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INACTIVE_WINDOW_ATTRIBUTE,
  installInactiveWindowAttribute
} from './inactive-window-attribute'

let dispose: (() => void) | null = null
let emitFocusChanged: ((isFocused: boolean) => void) | null = null
const unsubscribe = vi.fn()

function isMarkedInactive(): boolean {
  return document.documentElement.hasAttribute(INACTIVE_WINDOW_ATTRIBUTE)
}

beforeEach(() => {
  emitFocusChanged = null
  unsubscribe.mockClear()
  vi.stubGlobal('api', {
    ui: {
      onWindowFocusChanged: (callback: (isFocused: boolean) => void) => {
        emitFocusChanged = callback
        return unsubscribe
      }
    }
  })
})

afterEach(() => {
  dispose?.()
  dispose = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('inactive window attribute', () => {
  it('starts from the document focus, then follows OS focus from main', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    dispose = installInactiveWindowAttribute()
    expect(isMarkedInactive()).toBe(true)

    emitFocusChanged?.(true)
    expect(isMarkedInactive()).toBe(false)
    emitFocusChanged?.(false)
    expect(isMarkedInactive()).toBe(true)
  })

  it('stays active while focus moves into a webview in the focused window', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    dispose = installInactiveWindowAttribute()
    // Measured in Electron: a focused webview blurs the embedder and hasFocus() turns false,
    // while main reports no OS focus change.
    hasFocus.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    expect(isMarkedInactive()).toBe(false)
  })

  it('unsubscribes and clears the attribute when disposed', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    dispose = installInactiveWindowAttribute()
    dispose()
    dispose = null
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(isMarkedInactive()).toBe(false)
  })
})
