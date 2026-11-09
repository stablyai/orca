import { describe, expect, it } from 'vitest'
import {
  shouldHandleAutomationListSearchArrowKey,
  shouldHandleAutomationListSearchEnterKey
} from './automation-list-keyboard-navigation'

describe('shouldHandleAutomationListSearchArrowKey', () => {
  function event(
    overrides: Partial<{
      key: string
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      isComposing: boolean
    }> = {}
  ) {
    return {
      key: 'ArrowDown',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      ...overrides
    }
  }

  it('ignores composing, modified, and non-arrow keys', () => {
    expect(shouldHandleAutomationListSearchArrowKey(event({ isComposing: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchArrowKey(event({ key: 'Escape' }))).toBe(false)
  })
})

describe('shouldHandleAutomationListSearchEnterKey', () => {
  function event(
    overrides: Partial<{
      key: string
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      isComposing: boolean
    }> = {}
  ) {
    return {
      key: 'Enter',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: overrides.isComposing ?? false },
      ...overrides
    }
  }

  it('ignores composing, modified, and non-enter keys', () => {
    expect(shouldHandleAutomationListSearchEnterKey(event({ isComposing: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ metaKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ ctrlKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ altKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ shiftKey: true }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ key: 'ArrowDown' }))).toBe(false)
    expect(shouldHandleAutomationListSearchEnterKey(event({ key: 'Escape' }))).toBe(false)
  })
})
