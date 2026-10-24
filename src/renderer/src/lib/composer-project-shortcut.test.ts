import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getComposerProjectShortcutKeys,
  isComposerProjectShortcut
} from './composer-project-shortcut'

function setUserAgent(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

describe('composer project shortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matches Option+P on macOS by physical key even though key is π', () => {
    setUserAgent('Macintosh')

    expect(isComposerProjectShortcut({ key: 'π', code: 'KeyP', altKey: true })).toBe(true)
    expect(getComposerProjectShortcutKeys()).toEqual(['⌥', 'P'])
  })

  it('matches Alt+P on Linux and Windows', () => {
    setUserAgent('X11; Linux x86_64')

    expect(isComposerProjectShortcut({ key: 'p', code: 'KeyP', altKey: true })).toBe(true)
    expect(getComposerProjectShortcutKeys()).toEqual(['Alt', 'P'])
  })

  it('requires Alt alone as the modifier', () => {
    expect(isComposerProjectShortcut({ key: 'p', code: 'KeyP' })).toBe(false)
    expect(
      isComposerProjectShortcut({ key: 'P', code: 'KeyP', altKey: true, shiftKey: true })
    ).toBe(false)
    expect(isComposerProjectShortcut({ key: 'p', code: 'KeyP', altKey: true, metaKey: true })).toBe(
      false
    )
    expect(isComposerProjectShortcut({ key: 'p', code: 'KeyP', altKey: true, ctrlKey: true })).toBe(
      false
    )
  })

  it('ignores other keys', () => {
    expect(isComposerProjectShortcut({ key: 'ø', code: 'KeyO', altKey: true })).toBe(false)
  })

  it('ignores keys owned by an IME composition', () => {
    expect(
      isComposerProjectShortcut({ key: 'p', code: 'KeyP', altKey: true, isComposing: true })
    ).toBe(false)
  })
})
