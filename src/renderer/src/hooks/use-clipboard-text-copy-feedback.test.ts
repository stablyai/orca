// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipboardTextCopyFeedback } from './use-clipboard-text-copy-feedback'

let writeClipboardText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  writeClipboardText = vi.fn().mockResolvedValue(undefined)
  Object.assign(window, { api: { ui: { writeClipboardText } } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useClipboardTextCopyFeedback', () => {
  it('copies non-empty text and reports success', async () => {
    const { result } = renderHook(() => useClipboardTextCopyFeedback('git status'))

    expect(result.current.canCopy).toBe(true)

    let ok = false
    await act(async () => {
      ok = await result.current.copyText()
    })

    expect(ok).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('git status')
    expect(result.current.status).toBe('copied')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(result.current.status).toBe('idle')
  })

  it('does not write whitespace-only text', async () => {
    const { result } = renderHook(() => useClipboardTextCopyFeedback('   '))

    expect(result.current.canCopy).toBe(false)

    let ok = true
    await act(async () => {
      ok = await result.current.copyText()
    })

    expect(ok).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('reports failure without leaving a success state', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('denied'))
    const { result } = renderHook(() => useClipboardTextCopyFeedback('git status'))

    let ok = true
    await act(async () => {
      ok = await result.current.copyText()
    })

    expect(ok).toBe(false)
    expect(result.current.status).toBe('failed')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(result.current.status).toBe('idle')
  })

  it('drops feedback when the text changes', async () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useClipboardTextCopyFeedback(text),
      { initialProps: { text: 'git status' } }
    )

    await act(async () => {
      await result.current.copyText()
    })
    expect(result.current.status).toBe('copied')

    rerender({ text: 'git diff' })
    expect(result.current.status).toBe('idle')
  })

  it('does not set state after unmount', async () => {
    let resolveWrite: (() => void) | null = null
    writeClipboardText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        })
    )

    const { result, unmount } = renderHook(() => useClipboardTextCopyFeedback('git status'))

    let copyPromise: Promise<boolean> | null = null
    act(() => {
      copyPromise = result.current.copyText()
    })

    unmount()
    await act(async () => {
      resolveWrite?.()
      await copyPromise
    })

    // Unmounted: no throw from setState; promise still resolves true for the write.
    await expect(copyPromise).resolves.toBe(true)
  })
})
