// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useImeEnterGestureOwnership } from './ime-composition-keyboard-event'

type Step =
  | { type: 'keydown'; key: string; keyCode: number; isComposing: boolean }
  | { type: 'compositionstart' }
  | { type: 'compositionend' }

function keydown(key: string, keyCode: number, isComposing: boolean): Step {
  return { type: 'keydown', key, keyCode, isComposing }
}

// Keydown and composition events recorded from one Enter press in Electron 43 on Linux IBus.
const PINYIN_RAW_LETTERS_ENTER: Step[] = [
  { type: 'compositionstart' },
  keydown('Process', 229, true),
  { type: 'compositionend' }
]
// Chromium on macOS reports a candidate-confirming Enter as key Enter with keyCode 229.
const MACOS_CANDIDATE_CONFIRM_ENTER: Step[] = [
  { type: 'compositionstart' },
  keydown('Enter', 229, true),
  { type: 'compositionend' }
]
const VIETNAMESE_TELEX_ENTER: Step[] = [
  { type: 'compositionstart' },
  keydown('Process', 229, true),
  { type: 'compositionend' },
  keydown('Enter', 13, false)
]

/** The Enter keydowns the field acts on, as a consumer that skips IME-owned keys would see. */
function submittedEnters(steps: Step[]): number {
  const { result } = renderHook(() => useImeEnterGestureOwnership())
  let submitted = 0
  for (const step of steps) {
    if (step.type === 'compositionstart') {
      result.current.setComposing(true)
    } else if (step.type === 'compositionend') {
      result.current.setComposing(false)
    } else {
      const event: Pick<ReactKeyboardEvent, 'key' | 'keyCode' | 'nativeEvent'> & { code: string } =
        {
          key: step.key,
          keyCode: step.keyCode,
          code: 'Enter',
          nativeEvent: new KeyboardEvent('keydown', {
            key: step.key,
            isComposing: step.isComposing
          })
        }
      if (!result.current.ownsKeyDown(event) && step.key === 'Enter') {
        submitted += 1
      }
    }
  }
  return submitted
}

describe('useImeEnterGestureOwnership', () => {
  it('keeps the Enter that confirms a Pinyin composition from submitting', () => {
    expect(submittedEnters(PINYIN_RAW_LETTERS_ENTER)).toBe(0)
  })

  it('keeps a macOS candidate-confirming Enter from submitting', () => {
    expect(submittedEnters(MACOS_CANDIDATE_CONFIRM_ENTER)).toBe(0)
  })

  it('submits on the one Enter that commits Vietnamese Telex', () => {
    expect(submittedEnters(VIETNAMESE_TELEX_ENTER)).toBe(1)
  })
})
