// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useNativeChatReaderReturn } from './use-native-chat-reader-return'

it('requires reader movement and rejects a geometry-only clamp', () => {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    scrollTop: { value: 360, writable: true },
    clientHeight: { value: 600, writable: true },
    scrollHeight: { value: 1000, writable: true }
  })
  const previous = { current: { scrollTop: 360, clientHeight: 600, scrollHeight: 1000 } }
  const view = renderHook(() =>
    useNativeChatReaderReturn({ current: element }, { current: true }, previous)
  )
  const geometry = { scrollTop: 320, clientHeight: 680, scrollHeight: 1000 }
  expect(view.result.current.readerReturned(geometry, false)).toBe(false)
  view.result.current.recordReaderScroll()
  expect(view.result.current.readerReturned(geometry, false)).toBe(false)
  view.result.current.recordReaderScroll()
  expect(
    view.result.current.readerReturned(
      { scrollTop: 400, clientHeight: 600, scrollHeight: 1000 },
      true
    )
  ).toBe(false)
  expect(
    view.result.current.readerReturned(
      { scrollTop: 400, clientHeight: 600, scrollHeight: 1000 },
      false
    )
  ).toBe(false)
  view.unmount()
})

it('rebases a continuing reader gesture across compensation without crediting a later clamp', () => {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    scrollTop: { value: 1400, writable: true },
    clientHeight: { value: 600, writable: true },
    scrollHeight: { value: 2000, writable: true }
  })
  const following = { current: false }
  const previous = { current: { scrollTop: 1400, clientHeight: 600, scrollHeight: 2000 } }
  const view = renderHook(() =>
    useNativeChatReaderReturn({ current: element }, following, previous)
  )
  const observe = (scrollTop: number, scrollHeight: number, programmatic = false) =>
    view.result.current.readerReturned({ scrollTop, clientHeight: 600, scrollHeight }, programmatic)
  view.result.current.recordReaderScroll()
  expect(observe(1380, 2000)).toBe(false)
  expect(observe(1580, 2200, true)).toBe(false)
  following.current = true
  expect(observe(1540, 2140)).toBe(false)

  // A scrollbar drag or touch momentum can continue without a second input callback.
  following.current = false
  view.result.current.observeVisibility(true, true)
  view.result.current.recordReaderScroll()
  expect(observe(1380, 2000)).toBe(false)
  expect(observe(1580, 2200, true)).toBe(false)
  expect(observe(1580, 2200, true)).toBe(false)
  expect(observe(1590, 2200)).toBe(false)
  following.current = true
  expect(observe(1600, 2200)).toBe(true)
  expect(observe(1600, 2200)).toBe(false)

  // A smaller measured row is a known compensation, not an ambiguous browser clamp.
  following.current = false
  view.result.current.observeVisibility(true, true)
  view.result.current.recordReaderScroll()
  expect(observe(1380, 2000)).toBe(false)
  expect(observe(1260, 1880, true)).toBe(false)
  expect(observe(1270, 1880)).toBe(false)
  following.current = true
  expect(observe(1280, 1880)).toBe(true)
  view.unmount()
})
