// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatHistoryRetention } from './use-native-chat-history-retention'

it('holds parked history through hidden renders and releases on return, rebind and unmount', () => {
  const release = vi.fn()
  const retainHistory = vi.fn(() => release)
  const trimHistory = vi.fn()
  const view = renderHook(
    (source) =>
      useNativeChatHistoryRetention({ ...source, root: { current: null }, sourceKey: 'test' }),
    {
      initialProps: { retainHistory, trimHistory }
    }
  )
  act(() => {
    view.result.current.leaveEnd()
    view.result.current.leaveEnd()
  })
  view.rerender({ retainHistory, trimHistory })
  expect(retainHistory).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
  act(() => view.result.current.returnToEnd())
  expect(release).toHaveBeenCalledOnce()
  act(() => view.result.current.leaveEnd())
  const nextRelease = vi.fn()
  const nextRetain = vi.fn(() => nextRelease)
  view.rerender({ retainHistory: nextRetain, trimHistory })
  expect(release).toHaveBeenCalledTimes(2)
  act(() => view.result.current.leaveEnd())
  view.unmount()
  expect(nextRelease).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'preserves a mounted selection until it clears (shared source: %s)',
  (shared) => {
    const element = document.createElement('div')
    element.textContent = 'Selected folded tool lead'
    document.body.append(element)
    const root = { current: element }
    const selected = document.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(element)
    selected.removeAllRanges()
    selected.addRange(range)
    const release = vi.fn()
    const retainHistory = shared ? vi.fn(() => release) : undefined
    const trimHistory = vi.fn()
    const view = renderHook(
      (isVisible) =>
        useNativeChatHistoryRetention({
          root,
          sourceKey: 'source',
          retainHistory,
          trimHistory,
          isVisible
        }),
      { initialProps: true }
    )
    act(() => view.result.current.returnToEnd())
    expect(trimHistory).toHaveBeenCalledTimes(shared ? 1 : 0)
    trimHistory.mockClear()
    expect(release).not.toHaveBeenCalled()
    act(() => view.result.current.leaveEnd())
    view.rerender(false)
    act(() => {
      selected.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(trimHistory).not.toHaveBeenCalled()
    act(() => view.result.current.returnToEnd())
    expect(trimHistory).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(shared ? 2 : 0)
    view.unmount()
    element.remove()
  }
)

it.each([false, true])(
  'reads a departure immediately when a send returns before the next render (shared: %s)',
  (shared) => {
    const release = vi.fn()
    const retainHistory = shared ? () => release : undefined
    const trimHistory = vi.fn()
    const view = renderHook(() =>
      useNativeChatHistoryRetention({
        root: { current: null },
        sourceKey: 'same-turn',
        retainHistory,
        trimHistory
      })
    )
    act(() => {
      view.result.current.leaveEnd()
      view.result.current.returnToEnd('send')
    })
    expect(trimHistory).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(shared ? 1 : 0)
    view.unmount()
  }
)
