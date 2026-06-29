import { describe, expect, it } from 'vitest'
import {
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
  it('redirects printable typing from the native chat pane', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'x' }))).toBe(true)
  })

  it('does not redirect shortcuts or non-printable keys', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'Enter' }))).toBe(false)
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'a', metaKey: true }))).toBe(false)
    expect(shouldRedirectNativeChatTyping(keyEvent({ key: 'a', ctrlKey: true }))).toBe(false)
  })

  it('does not redirect IME composition or already-handled events', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ isComposing: true }))).toBe(false)
    expect(shouldRedirectNativeChatTyping(keyEvent({ defaultPrevented: true }))).toBe(false)
  })

  it('leaves interactive targets alone', () => {
    expect(shouldRedirectNativeChatTyping(keyEvent({ target: interactiveTarget() }))).toBe(false)
  })
})

describe('shouldFocusNativeChatPaneFromPointerTarget', () => {
  it('focuses the pane for non-interactive clicks', () => {
    expect(shouldFocusNativeChatPaneFromPointerTarget(inertTarget())).toBe(true)
  })

  it('does not steal focus from controls', () => {
    expect(shouldFocusNativeChatPaneFromPointerTarget(interactiveTarget())).toBe(false)
  })
})
