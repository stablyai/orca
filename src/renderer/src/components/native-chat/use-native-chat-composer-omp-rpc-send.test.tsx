// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerOmpRpcSend } from './use-native-chat-composer-omp-rpc-send'

describe('useNativeChatComposerOmpRpcSend', () => {
  it('applies follow-up to one send and clears the toggle immediately', () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const { result } = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: true, send },
        setNotice: vi.fn()
      })
    )

    act(() => result.current.followUp?.onToggle())
    expect(result.current.followUp?.active).toBe(true)

    act(() => expect(result.current.sendOmpRpcChat('later')).toBe(true))
    expect(send).toHaveBeenCalledWith({ message: 'later', behavior: 'followUp' })
    expect(result.current.followUp?.active).toBe(false)
  })

  it('routes a chat send rejected after unmount to the pane-owned notice', async () => {
    // The binding wiring is what a hook-level test cannot see: without it the
    // durable reporter is undefined and the failure dies with the composer.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const reportMessageFailure = vi.fn()
    const setNotice = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: false, send, reportMessageFailure },
        setNotice
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(reportMessageFailure).toHaveBeenCalledTimes(1)
    expect(setNotice).not.toHaveBeenCalled()
  })

  it('routes the echo retraction of a failed send through the binding', async () => {
    // Binding wiring the hook-level test cannot see: leave
    // `onOptimisticSendCanceled` unthreaded here and a failed message keeps
    // rendering as delivered in the pane cache, whichever notice route ran.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const onOptimisticSend = vi.fn().mockReturnValue('pending-1')
    const onOptimisticSendCanceled = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: { isOwned: true, isTurnWorking: false, send },
        onOptimisticSend,
        onOptimisticSendCanceled,
        setNotice: vi.fn()
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(onOptimisticSendCanceled).toHaveBeenCalledExactlyOnceWith('pending-1')
  })

  it("fences the pane-owned message notice with the binding's session generation", async () => {
    // The binding wiring again: the reporter is only safe if the generation
    // reaches it, otherwise the notice lands in whatever session holds the
    // paneKey when the rejection settles.
    let reject: ((error: Error) => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, settle) => {
          reject = settle
        })
    )
    const reportMessageFailure = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerOmpRpcSend({
        agent: 'omp',
        ompRpcChat: {
          isOwned: true,
          isTurnWorking: false,
          send,
          reportMessageFailure,
          sessionGeneration: 7
        },
        setNotice: vi.fn()
      })
    )

    act(() => expect(hook.result.current.sendOmpRpcChat('hello')).toBe(true))
    hook.unmount()
    await act(async () => {
      reject?.(new Error('handler torn down'))
    })

    expect(reportMessageFailure).toHaveBeenCalledWith(7)
  })
})
