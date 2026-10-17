// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatTerminalAsyncReply } from './use-native-chat-terminal-async-reply'
import {
  resetNativeChatPtySendQueuesForTests,
  NATIVE_CHAT_SUBMIT_DELAY_MS
} from './native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'

const io = vi.hoisted(() => ({
  write: vi.fn(),
  verified: vi.fn<() => Promise<boolean>>(),
  report: vi.fn()
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: io.report
}))

/** Uses a remote session fixture to check that replies are reported to the correct host. */
function args() {
  return {
    paneKey: 'pane-a',
    sessionId: 'session-a',
    targetPtyId: 'remote-pty-a',
    runtimeEnvironmentId: 'ssh-host-a',
    disabled: false,
    cancelInFlight: false,
    delivery: {
      pending: [],
      notices: new Map(),
      record: vi.fn(() => 'pending-a'),
      reject: vi.fn(),
      holdUnconfirmed: vi.fn(),
      clear: vi.fn(),
      cancel: vi.fn()
    },
    onSubmitted: vi.fn()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  io.verified.mockResolvedValue(true)
})
afterEach(() => {
  cleanup()
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})

it('waits for the body acknowledgement before Enter and reports the originating host', async () => {
  const body = Promise.withResolvers<boolean>()
  io.verified.mockReturnValueOnce(body.promise)
  const input = args()
  const { result } = renderHook(() => useNativeChatTerminalAsyncReply(input))
  let sending: boolean | Promise<boolean> = false
  act(() => {
    sending = result.current.reply.send('Which branch?\nrelease')
  })
  expect(result.current.reply.disabled).toBe(true)
  expect(input.delivery.record).toHaveBeenCalledExactlyOnceWith('Which branch?\nrelease')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(io.verified).toHaveBeenCalledExactlyOnceWith(
    'remote-pty-a',
    buildNativeChatPasteBytes('Which branch?\nrelease'),
    'driving',
    { requireWriteSettlement: true }
  )
  expect(input.onSubmitted).not.toHaveBeenCalled()
  await act(async () => {
    body.resolve(true)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
  })
  expect(io.verified).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(await sending).toBe(true)
  expect(io.verified).toHaveBeenLastCalledWith('remote-pty-a', NATIVE_CHAT_SUBMIT, 'driving', {
    requireWriteSettlement: true
  })
  expect(io.report).toHaveBeenCalledExactlyOnceWith('pane-a', 'ssh-host-a')
  expect(input.onSubmitted).toHaveBeenCalledTimes(1)
  expect(result.current.reply.disabled).toBe(false)
})

it.each(['rejected', 'unknown'] as const)(
  'keeps an unsuccessful %s reply visible without resending it',
  async (outcome) => {
    if (outcome === 'rejected') {
      io.verified.mockResolvedValueOnce(false)
    } else {
      io.verified.mockRejectedValueOnce(new Error('Remote acknowledgement lost'))
    }
    const input = args()
    const { result } = renderHook(() => useNativeChatTerminalAsyncReply(input))
    let sending: boolean | Promise<boolean> = false
    await act(async () => {
      sending = result.current.reply.send('answer')
    })
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    expect(await sending).toBe(false)
    expect(io.verified.mock.calls).toHaveLength(outcome === 'rejected' ? 1 : 2)
    expect(input.delivery.reject).toHaveBeenCalledTimes(outcome === 'rejected' ? 1 : 0)
    expect(input.delivery.holdUnconfirmed).toHaveBeenCalledTimes(outcome === 'unknown' ? 1 : 0)
    expect(input.onSubmitted).not.toHaveBeenCalled()
    expect(io.report).not.toHaveBeenCalled()
  }
)

it.each(['blocked', 'session', 'host', 'terminal', 'stop', 'unmount'] as const)(
  'ignores a late remote acknowledgement after %s and leaves the new input alone',
  async (change) => {
    const body = Promise.withResolvers<boolean>()
    io.verified.mockReturnValueOnce(body.promise)
    const input = args()
    const { result, rerender, unmount } = renderHook(useNativeChatTerminalAsyncReply, {
      initialProps: input
    })
    const oldSend = result.current.reply.send
    let sending: boolean | Promise<boolean> = false
    act(() => {
      sending = oldSend('answer')
    })
    if (change === 'stop') {
      act(() => result.current.cancel())
    } else if (change === 'unmount') {
      unmount()
    } else {
      rerender({
        ...input,
        disabled: change === 'blocked',
        cancelInFlight: change === 'blocked',
        sessionId: change === 'session' ? 'session-b' : input.sessionId,
        runtimeEnvironmentId: change === 'host' ? 'ssh-host-b' : input.runtimeEnvironmentId,
        targetPtyId: change === 'terminal' ? 'remote-pty-b' : input.targetPtyId
      })
    }
    expect(await sending).toBe(false)
    await act(async () => {
      body.resolve(true)
      await vi.runAllTimersAsync()
    })
    expect(io.verified).toHaveBeenCalledTimes(1)
    expect(io.write).toHaveBeenCalledExactlyOnceWith('remote-pty-a', '\x15', 'driving')
    expect(input.delivery.holdUnconfirmed).toHaveBeenCalledWith('pending-a')
    expect(input.onSubmitted).not.toHaveBeenCalled()
    expect(io.report).not.toHaveBeenCalled()
    if (change !== 'stop') {
      expect(await oldSend('stale answer')).toBe(false)
    }
  }
)

it('rejects a second answer while the first is awaiting acknowledgement', async () => {
  const body = Promise.withResolvers<boolean>()
  io.verified.mockReturnValueOnce(body.promise)
  const input = args()
  const { result } = renderHook(() => useNativeChatTerminalAsyncReply(input))
  act(() => {
    void result.current.reply.send('first')
  })
  await act(async () => {
    expect(await result.current.reply.send('second')).toBe(false)
  })
  expect(input.delivery.record).toHaveBeenCalledTimes(1)
  expect(io.verified).toHaveBeenCalledTimes(1)
})

it('finishes an admitted send when the view hides or its transcript temporarily stops being ready', async () => {
  const input = args()
  const { result, rerender } = renderHook(useNativeChatTerminalAsyncReply, { initialProps: input })
  let sending: boolean | Promise<boolean> = false
  await act(async () => {
    sending = result.current.reply.send('answer')
  })
  expect(io.verified).toHaveBeenCalledTimes(1)
  rerender({ ...input, disabled: true })
  expect(await result.current.reply.send('another answer')).toBe(false)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
  })
  expect(await sending).toBe(true)
  expect(io.verified).toHaveBeenLastCalledWith('remote-pty-a', NATIVE_CHAT_SUBMIT, 'driving', {
    requireWriteSettlement: true
  })
  expect(input.delivery.holdUnconfirmed).not.toHaveBeenCalled()
  expect(input.onSubmitted).toHaveBeenCalledTimes(1)
})
