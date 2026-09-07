// @vitest-environment happy-dom

import { StrictMode } from 'react'
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

describe('useDebouncedSettingsTextDraft', () => {
  it('shows every keystroke immediately but commits once', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: '', commit }))

    for (const next of ['w', 'wr', 'wrk']) {
      act(() => result.current.onChange(next))
    }

    expect(result.current.value).toBe('wrk')
    expect(commit).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('wrk')
  })

  it('commits immediately on blur without waiting for the debounce', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: '', commit }))

    act(() => result.current.onChange('abc'))
    act(() => result.current.onBlur())

    expect(commit).toHaveBeenCalledExactlyOnceWith('abc')

    act(() => {
      vi.advanceTimersByTime(700)
    })

    // The pending timer must not fire a second, duplicate commit.
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('commits a pending edit when the field unmounts', () => {
    const commit = vi.fn()
    const { result, unmount } = renderHook(() =>
      useDebouncedSettingsTextDraft({ value: '', commit })
    )

    act(() => result.current.onChange('half-typed'))
    unmount()

    expect(commit).toHaveBeenCalledExactlyOnceWith('half-typed')
  })

  it('adopts an external value while the field is untouched', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: 'first' } }
    )

    rerender({ value: 'from-another-window' })

    expect(result.current.value).toBe('from-another-window')
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not let an external value overwrite an in-progress edit', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: 'first' } }
    )

    act(() => result.current.onChange('typing'))
    rerender({ value: 'from-another-window' })

    expect(result.current.value).toBe('typing')
  })

  it('does not commit when nothing was edited', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: 'x', commit }))

    act(() => result.current.onBlur())

    expect(commit).not.toHaveBeenCalled()
  })
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

    // The later unmount and timer must not commit the same value again.
    unmount()
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('does not commit on beforeunload when nothing is pending', () => {
    const commit = vi.fn()
    renderHook(() => useDebouncedSettingsTextDraft({ value: 'x', commit }))

    act(() => {
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    })

    expect(commit).not.toHaveBeenCalled()
  })

  it('stops listening for beforeunload after unmount', () => {
    const commit = vi.fn()
    const { result, unmount } = renderHook(() =>
      useDebouncedSettingsTextDraft({ value: '', commit })
    )

    act(() => result.current.onChange('abc'))
    unmount()
    act(() => {
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    })

    expect(commit).toHaveBeenCalledExactlyOnceWith('abc')
  })

  it('commits every edit burst, not only the first', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: '', commit }))

    act(() => result.current.onChange('one'))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    act(() => result.current.onChange('one two'))
    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(commit).toHaveBeenNthCalledWith(1, 'one')
    expect(commit).toHaveBeenNthCalledWith(2, 'one two')
  })

  it('adopts external values again once a pending edit has been committed', () => {
    const commit = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedSettingsTextDraft({ value, commit }),
      { initialProps: { value: '' } }
    )

    act(() => result.current.onChange('typed'))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(commit).toHaveBeenCalledExactlyOnceWith('typed')

    // The store echoes the commit, then another window writes a different value.
    rerender({ value: 'typed' })
    rerender({ value: 'from-another-window' })

    expect(result.current.value).toBe('from-another-window')
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
    // The store echoes the first commit after the user has already typed more.
    rerender({ value: 'abc' })

    expect(result.current.value).toBe('abcd')

    act(() => result.current.onBlur())
    expect(commit).toHaveBeenLastCalledWith('abcd')
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('does not spuriously commit under StrictMode effect replay', () => {
    const commit = vi.fn()
    const { result } = renderHook(() => useDebouncedSettingsTextDraft({ value: 'x', commit }), {
      wrapper: StrictMode
    })

    expect(commit).not.toHaveBeenCalled()

    act(() => result.current.onChange('xy'))
    act(() => result.current.onBlur())

    expect(commit).toHaveBeenCalledExactlyOnceWith('xy')
  })
})
