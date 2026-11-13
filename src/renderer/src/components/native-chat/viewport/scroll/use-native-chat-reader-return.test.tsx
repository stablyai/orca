// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatReaderReturn } from './use-native-chat-reader-return'

describe('reader movement', () => {
  it('reports reading during detached scrolling without releasing browsed history', () => {
    const element = document.createElement('div')
    const previous = { current: { scrollTop: 100, scrollHeight: 2000, clientHeight: 500 } }
    const view = renderHook(() =>
      useNativeChatReaderReturn({ current: element }, { current: false }, previous)
    )
    const read = vi.fn()
    act(() => view.result.current.recordReaderScroll())
    expect(
      view.result.current.readerReturned(
        { scrollTop: 150, scrollHeight: 2000, clientHeight: 500 },
        true,
        read
      )
    ).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(
      view.result.current.readerReturned(
        { scrollTop: 200, scrollHeight: 2000, clientHeight: 500 },
        false,
        read
      )
    ).toBe(false)
    expect(read).toHaveBeenCalledWith(element)
  })

  it('keeps Find navigation out of read scrolling while allowing return to live history', () => {
    const element = document.createElement('div')
    const previous = { current: { scrollTop: 100, scrollHeight: 2000, clientHeight: 500 } }
    const view = renderHook(() =>
      useNativeChatReaderReturn({ current: element }, { current: true }, previous)
    )
    const read = vi.fn()
    act(() => view.result.current.recordReaderScroll('navigation'))
    expect(
      view.result.current.readerReturned(
        { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 },
        false,
        read
      )
    ).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })
})
