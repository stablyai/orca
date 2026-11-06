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
  const view = renderHook(() => useNativeChatReaderReturn({ current: element }, { current: true }))
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
  ).toBe(true)
  view.unmount()
})
