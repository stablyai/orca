import { describe, expect, it } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { isImeCompositionKeyDown, isImeOwnedKeyboardEvent } from './ime-composition-keyboard-event'

function keyEvent(nativeEvent: { isComposing?: boolean; keyCode?: number }): ReactKeyboardEvent {
  return {
    nativeEvent: {
      isComposing: nativeEvent.isComposing ?? false,
      keyCode: nativeEvent.keyCode ?? 13
    }
  } as unknown as ReactKeyboardEvent
}

describe('isImeCompositionKeyDown', () => {
  it('owns the marked real Enter shape without treating plain Enter as IME input', () => {
    expect(isImeOwnedKeyboardEvent({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 13 })).toBe(false)
  })

  it('is true while the IME is composing', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: true }))).toBe(true)
  })

  it('is true for the keyCode 229 fallback when isComposing is not set', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('is false for a plain Enter outside of composition', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false)
  })
})
