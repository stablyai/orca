import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getScreenSubmitModifierLabel,
  getScreenSubmitShortcutLabel,
  isScreenSubmitShortcut
} from './screen-submit-shortcut'

function setUserAgent(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

describe('screen submit shortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Cmd+Enter on macOS', () => {
    setUserAgent('Macintosh')

    expect(isScreenSubmitShortcut({ key: 'Enter', metaKey: true })).toBe(true)
    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true })).toBe(false)
    expect(getScreenSubmitModifierLabel()).toBe('⌘')
    expect(getScreenSubmitShortcutLabel()).toBe('⌘ Enter')
  })

  it('uses Ctrl+Enter off macOS', () => {
    setUserAgent('Linux')

    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true })).toBe(true)
    expect(isScreenSubmitShortcut({ key: 'Enter', metaKey: true })).toBe(false)
    expect(getScreenSubmitModifierLabel()).toBe('Ctrl')
    expect(getScreenSubmitShortcutLabel()).toBe('Ctrl+Enter')
  })

  it('ignores shifted or alternate Enter chords', () => {
    setUserAgent('Linux')

    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true, altKey: true })).toBe(false)
    expect(isScreenSubmitShortcut({ key: 'Escape', ctrlKey: true })).toBe(false)
  })

  it('ignores composing Enter events', () => {
    setUserAgent('Linux')

    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false)
    expect(
      isScreenSubmitShortcut({
        key: 'Enter',
        ctrlKey: true,
        nativeEvent: { isComposing: true }
      })
    ).toBe(false)
  })
})
