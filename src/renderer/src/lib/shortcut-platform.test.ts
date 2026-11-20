// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { isSelectAllShortcut } from './text-input/focus/editable-target'
import { getShortcutPlatform } from './keyboard/shortcut-platform'

const originalUserAgent = navigator.userAgent
const originalMaxTouchPoints = navigator.maxTouchPoints

/** iPadOS desktop mode reports a Mac UA and omits "iPad"; touch points are the tell. */
const IPAD_DESKTOP_MODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const MAC_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const baseModifiers = { altKey: false, shiftKey: false } as const

function stubNavigator(userAgent: string, maxTouchPoints: number): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints })
}

afterEach(() => stubNavigator(originalUserAgent, originalMaxTouchPoints))

describe('shortcut platform on a tablet web client', () => {
  it('resolves iPadOS desktop mode to darwin so Cmd chords fire on an attached keyboard', () => {
    stubNavigator(IPAD_DESKTOP_MODE_UA, 5)
    expect(getShortcutPlatform()).toBe('darwin')
    expect(isSelectAllShortcut({ ...baseModifiers, key: 'a', metaKey: true, ctrlKey: false })).toBe(
      true
    )
  })

  it('keeps a real Mac on darwin without needing a touch screen', () => {
    stubNavigator(MAC_DESKTOP_UA, 0)
    expect(getShortcutPlatform()).toBe('darwin')
  })

  it('keeps non-Mac platforms on their own primary modifier', () => {
    stubNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0', 0)
    expect(getShortcutPlatform()).toBe('win32')
    expect(isSelectAllShortcut({ ...baseModifiers, key: 'a', metaKey: false, ctrlKey: true })).toBe(
      true
    )

    stubNavigator('Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0', 0)
    expect(getShortcutPlatform()).toBe('linux')
  })
})
