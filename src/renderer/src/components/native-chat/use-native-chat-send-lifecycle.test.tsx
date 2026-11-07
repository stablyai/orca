// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'

function handle(settleAfterMs = 500) {
  return { cancel: vi.fn<() => void>(), settleAfterMs }
}

describe('useNativeChatSendLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels owned writes when the PTY target changes and when the composer unmounts', () => {
    vi.useFakeTimers()
    const first = handle()
    const second = handle()
    const onPendingSendCanceled = vi.fn()
    const { result, rerender, unmount } = renderHook(
      ({ targetPtyId }) => useNativeChatSendLifecycle('tab-1', targetPtyId, onPendingSendCanceled),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.trackPendingSend(first, 'pending-1'))
    rerender({ targetPtyId: 'pty-2' })
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')

    act(() => result.current.trackPendingSend(second, 'pending-2'))
    unmount()
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-2')
  })

  it('keeps a renderer-stalled send cancelable past its nominal schedule', async () => {
    vi.useFakeTimers()
    let resolveSettled!: () => void
    const stalled = {
      ...handle(640),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
    }
    const onPendingSendCanceled = vi.fn()
    const { result, rerender } = renderHook(
      ({ targetPtyId }) => useNativeChatSendLifecycle('tab-1', targetPtyId, onPendingSendCanceled),
      { initialProps: { targetPtyId: 'pty-1' as string | null } }
    )

    act(() => result.current.trackPendingSend(stalled, 'pending-1'))
    act(() => vi.advanceTimersByTime(stalled.settleAfterMs + 1_000))
    rerender({ targetPtyId: 'pty-2' })

    expect(stalled.cancel).toHaveBeenCalledOnce()
    expect(onPendingSendCanceled).toHaveBeenCalledWith('pending-1')
    await act(async () => {
      resolveSettled()
    })
  })
})
