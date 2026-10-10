// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  publishDictationMeter,
  resetDictationMeter,
  useDictationMeter
} from './dictation-meter-store'

beforeEach(resetDictationMeter)
afterEach(resetDictationMeter)

it('notifies only the scoped meter consumer when presentation state changes', () => {
  let renders = 0
  const { result } = renderHook(() => {
    renders += 1
    return useDictationMeter()
  })
  const speaking = { level: 0.72, isSpeaking: true, isClipping: false }

  act(() => publishDictationMeter(speaking))
  expect(result.current).toEqual(speaking)
  expect(renders).toBe(2)

  act(() => publishDictationMeter({ ...speaking }))
  expect(renders).toBe(2)
})
