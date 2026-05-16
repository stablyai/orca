// src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts
import { describe, it, expect } from 'vitest'
import { matchFileSearchShortcut, matchSearchNavigate } from './keyboard-handlers'

function makeKeyEvent(
  overrides: Partial<{
    key: string
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    repeat: boolean
  }>
): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'> {
  return {
    key: 'g',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides
  }
}

describe('matchSearchNavigate', () => {
  const isMac = true
  const searchState = { query: 'hello', caseSensitive: false, regex: false }

  it('returns "next" for Cmd+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('next')
  })

  it('returns "previous" for Cmd+Shift+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('previous')
  })

  it('returns null when search is closed', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, false, searchState)).toBeNull()
  })

  it('returns null when query is empty', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(
      matchSearchNavigate(e, isMac, true, { query: '', caseSensitive: false, regex: false })
    ).toBeNull()
  })

  it('returns null for wrong key', () => {
    const e = makeKeyEvent({ metaKey: true, key: 'f' })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns null when alt is pressed', () => {
    const e = makeKeyEvent({ metaKey: true, altKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns "next" for Ctrl+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('next')
  })

  it('returns "previous" for Ctrl+Shift+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('previous')
  })

  it('returns null for Ctrl+G on macOS (wrong modifier)', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, true, true, searchState)).toBeNull()
  })
})

describe('matchFileSearchShortcut', () => {
  it('matches Cmd+Shift+F on macOS', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true }), true)
    ).toBe(true)
  })

  it('matches Ctrl+Shift+F on Linux/Windows', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), false)
    ).toBe(true)
  })

  it('rejects repeats, alt, and the wrong platform modifier', () => {
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, repeat: true }),
        true
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, altKey: true }),
        true
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), true)
    ).toBe(false)
  })
})
