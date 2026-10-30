// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatInputForPaste,
  shouldFocusNativeChatPaneFromPointerTarget,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'

function keyEvent(
  overrides: Partial<Parameters<typeof shouldRedirectNativeChatTyping>[0]>
): Parameters<typeof shouldRedirectNativeChatTyping>[0] {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    target: inertTarget(),
    ...overrides
  }
}

function inertTarget(): EventTarget {
  return { closest: () => null } as unknown as EventTarget
}

function interactiveTarget(): EventTarget {
  return { closest: () => ({}) } as unknown as EventTarget
}

describe('shouldRedirectNativeChatTyping', () => {
  it('does not redirect IME composition or already-handled events', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ isComposing: true }), true)).toBe(false)
    expect(shouldRedirectNativeChatTyping(keyEvent({ defaultPrevented: true }), true)).toBe(false)
  })

  it('passes typed characters but not Space through a focused button or link', () => {
    const button = document.createElement('button')
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const roleButton = document.createElement('div')
    roleButton.setAttribute('role', 'button')
    for (const target of [button, link, roleButton]) {
      expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'h', target }), true)).toBe(true)
      expect(shouldRedirectNativeChatTyping(keyEvent({ key: ' ', target }), true)).toBe(false)
    }
  })

  it('lets Backspace/Delete and paste pass a focused button but not a text field', () => {
    const button = document.createElement('button')
    const field = document.createElement('input')
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', target: button }))
    ).toBe(true)
    expect(
      shouldFocusNativeChatInputForPaste(
        keyEvent({ key: 'v', metaKey: true, target: button }),
        true
      )
    ).toBe(true)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', target: field }))
    ).toBe(false)
    expect(shouldFocusNativeChatPaneFromPointerTarget(button)).toBe(false)
  })

  it('types Option characters on macOS but leaves Alt chords elsewhere', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'å', altKey: true }), true)).toBe(true)
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'z', altKey: true }), false)).toBe(false)
  })

  it('leaves typing with controls that own letters', () => {
    const option = document.createElement('div')
    option.setAttribute('role', 'option')
    const optionInButton = document.createElement('button')
    optionInButton.setAttribute('role', 'menuitem')
    for (const target of [document.createElement('input'), option, optionInButton]) {
      expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'h', target }), true)).toBe(false)
    }
  })
})

describe('shouldFocusNativeChatComposerFromEditingKey', () => {
  it('ignores other keys, shortcut/editing modifiers, IME composition, and handled events', () => {
    expect(shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'a' }))).toBe(false)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(
        keyEvent({ key: 'Backspace', defaultPrevented: true })
      )
    ).toBe(false)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', metaKey: true }))
    ).toBe(false)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', ctrlKey: true }))
    ).toBe(false)
    // Shift/Alt chords (cut, delete-word) belong to the focused target.
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Delete', shiftKey: true }))
    ).toBe(false)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', altKey: true }))
    ).toBe(false)
    expect(
      shouldFocusNativeChatComposerFromEditingKey(keyEvent({ key: 'Backspace', isComposing: true }))
    ).toBe(false)
  })
})

describe('shouldFocusNativeChatInputForPaste', () => {
  it('ignores the other platform chord, Alt chords, IME, handled events and inputs', () => {
    expect(shouldFocusNativeChatInputForPaste(keyEvent({ key: 'v', ctrlKey: true }), true)).toBe(
      false
    )
    expect(shouldFocusNativeChatInputForPaste(keyEvent({ key: 'v', metaKey: true }), false)).toBe(
      false
    )
    expect(
      shouldFocusNativeChatInputForPaste(keyEvent({ key: 'v', ctrlKey: true, altKey: true }), false)
    ).toBe(false)
    expect(
      shouldFocusNativeChatInputForPaste(
        keyEvent({ key: 'v', ctrlKey: true, isComposing: true }),
        false
      )
    ).toBe(false)
    expect(
      shouldFocusNativeChatInputForPaste(
        keyEvent({ key: 'v', ctrlKey: true, defaultPrevented: true }),
        false
      )
    ).toBe(false)
    expect(
      shouldFocusNativeChatInputForPaste(
        keyEvent({ key: 'v', ctrlKey: true, target: interactiveTarget() }),
        false
      )
    ).toBe(false)
  })
})
