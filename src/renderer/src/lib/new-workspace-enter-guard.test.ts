import { describe, it, expect } from 'vitest'
import { shouldSuppressEnterSubmit } from './new-workspace-enter-guard'

function makeEvent(overrides: Partial<{ isComposing: boolean; shiftKey: boolean }>): {
  isComposing: boolean
  shiftKey: boolean
} {
  return { isComposing: false, shiftKey: false, ...overrides }
}

describe('shouldSuppressEnterSubmit', () => {
  it('returns false for a plain Enter with no composition', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({}), false)).toBe(false)
  })

  it('returns true when IME composition is active', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ isComposing: true }), false)).toBe(true)
  })

  it('returns true for Shift+Enter inside a textarea', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ shiftKey: true }), true)).toBe(true)
  })

  it('returns false for Shift+Enter inside a non-textarea element', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ shiftKey: true }), false)).toBe(false)
  })

  it('returns true when both isComposing and shiftKey are true (textarea)', () => {
    expect(shouldSuppressEnterSubmit(makeEvent({ isComposing: true, shiftKey: true }), true)).toBe(
      true
    )
  })
})
