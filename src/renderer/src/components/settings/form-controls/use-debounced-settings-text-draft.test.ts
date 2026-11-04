// @vitest-environment happy-dom

// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSettingsTextDraft } from './use-debounced-settings-text-draft'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useDebouncedSettingsTextDraft flush paths', () => {
  it('commits a pending edit on beforeunload, since a window close never unmounts the tree', () => {
    const commit = vi.fn()
    const { result, unmount } = renderHook(() =>
      useDebouncedSettingsTextDraft({ value: '', commit })
    )

    act(() => result.current.onChange('quit-mid-word'))
    act(() => {
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    })

    expect(commit).toHaveBeenCalledExactlyOnceWith('quit-mid-word')

    unmount()
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('keeps a keystroke typed while the previous commit is still in flight', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: '' } }
    )

    act(() => result.current.onChange('abc'))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    act(() => result.current.onChange('abcd'))
    // Model a delayed commit echo arriving after further typing.
    rerender({ value: 'abc' })

    expect(result.current.value).toBe('abcd')

    act(() => result.current.onBlur())
    expect(commit).toHaveBeenLastCalledWith('abcd')
    expect(commit).toHaveBeenCalledTimes(2)
  })
})
