// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

it('opens an expired disclosure with fresh scroll and keeps the rest', () => {
  const { result } = renderHook(() => useNativeChatDisclosures())
  act(() => {
    for (let index = 0; index < MAX_NATIVE_CHAT_DISCLOSURES; index++) {
      result.current.write(`run:${index}`, true)
    }
  })
  result.current.runScroll.set('run:0', { top: 120, followsEnd: false })
  result.current.runScroll.set('run:2', { top: 40, followsEnd: false })

  act(() => result.current.write('run:new', true))

  expect(result.current.read('run:0')).toBeUndefined()
  expect(result.current.read('run:1')).toBe(true)
  expect(result.current.read('run:2')).toBe(true)
  expect(result.current.read('run:new')).toBe(true)

  result.current.runScroll.set('run:0', { top: 140, followsEnd: false })
  act(() => result.current.write('run:0', true))

  expect(result.current.read('run:0')).toBe(true)
  expect(result.current.read('run:1')).toBeUndefined()
  expect(result.current.runScroll.has('run:0')).toBe(false)
  expect(result.current.read('run:2')).toBe(true)
  expect(result.current.runScroll.get('run:2')).toEqual({ top: 40, followsEnd: false })
  expect(result.current.read('run:new')).toBe(true)
})
