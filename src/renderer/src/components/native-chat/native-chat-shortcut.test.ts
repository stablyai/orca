import { describe, it, expect } from 'vitest'
import {
  matchesNativeChatToggleShortcut,
  nativeChatToggleShortcutLabel
} from './native-chat-shortcut'

type Combo = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

function combo(overrides: Partial<Combo>): Combo {
  return { key: 'j', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

describe('nativeChatToggleShortcutLabel', () => {
  it('uses Cmd/Shift glyphs on Mac', () => {
    expect(nativeChatToggleShortcutLabel(true)).toBe('⌘⇧J')
  })

  it('uses Ctrl+/Shift+ text elsewhere', () => {
    expect(nativeChatToggleShortcutLabel(false)).toBe('Ctrl+Shift+J')
  })
})

describe('matchesNativeChatToggleShortcut', () => {
  it('matches Cmd+Shift+J on Mac', () => {
    expect(matchesNativeChatToggleShortcut(combo({ metaKey: true, shiftKey: true }), true)).toBe(
      true
    )
  })

  it('does not match Ctrl+Shift+J on Mac (wrong primary modifier)', () => {
    expect(matchesNativeChatToggleShortcut(combo({ ctrlKey: true, shiftKey: true }), true)).toBe(
      false
    )
  })

  it('matches Ctrl+Shift+J on Windows/Linux', () => {
    expect(matchesNativeChatToggleShortcut(combo({ ctrlKey: true, shiftKey: true }), false)).toBe(
      true
    )
  })

  it('requires the shift modifier', () => {
    expect(matchesNativeChatToggleShortcut(combo({ metaKey: true }), true)).toBe(false)
  })

  it('rejects when alt is held', () => {
    expect(
      matchesNativeChatToggleShortcut(combo({ metaKey: true, shiftKey: true, altKey: true }), true)
    ).toBe(false)
  })

  it('rejects a different key', () => {
    expect(
      matchesNativeChatToggleShortcut(combo({ key: 'k', metaKey: true, shiftKey: true }), true)
    ).toBe(false)
  })
})
