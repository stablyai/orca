import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
import {
  sendNativeChatMessage,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'
beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})
it('observes a refused write, skips Enter, and releases the queue for the next user action', async () => {
  const rejected = vi.fn()
  io.verified.mockResolvedValueOnce(false)
  sendNativeChatMessage(null, 'pane', 'refused', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused')
  ])
  sendNativeChatMessage(null, 'pane', 'next', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused'),
    buildNativeChatPasteBytes('next'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('reports a lost acknowledgment once as unconfirmed, never as rejection, and still submits', async () => {
  const rejected = vi.fn()
  const unconfirmed = vi.fn()
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  sendNativeChatMessage(null, 'pane', 'uncertain', {
    onWriteRejected: rejected,
    onWriteUnconfirmed: unconfirmed
  })
  await vi.advanceTimersByTimeAsync(120000)
  expect(rejected).not.toHaveBeenCalled()
  expect(unconfirmed).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('uncertain'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('serializes rapid sends through their acknowledged Enter and preserves the paste delay', async () => {
  const rejected = vi.fn()
  sendNativeChatMessage(null, 'pane', 'one', { onWriteRejected: rejected })
  sendNativeChatMessage(null, 'pane', 'two', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(499)
  expect(io.verified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(501)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('one'),
    NATIVE_CHAT_SUBMIT,
    buildNativeChatPasteBytes('two'),
    NATIVE_CHAT_SUBMIT
  ])
})

it.each(['accepted', 'refused', 'unknown'] as const)(
  'reports a pasted answer as acknowledged only after %s settlement',
  async (outcome) => {
    const settled = vi.fn()
    if (outcome === 'refused') {
      io.verified.mockResolvedValueOnce(false)
    } else if (outcome === 'unknown') {
      io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
    }
    sendNativeChatMessage(null, 'pane', 'answer', { onDeliverySettled: settled })
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'accepted')
    expect(io.verified.mock.calls.map((call) => call[2])).toEqual(
      outcome === 'refused'
        ? [buildNativeChatPasteBytes('answer')]
        : [buildNativeChatPasteBytes('answer'), NATIVE_CHAT_SUBMIT]
    )
  }
)

it('ignores a pasted answer acknowledgment after cancellation', async () => {
  let acknowledge: (accepted: boolean) => void = () => {}
  io.verified.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      acknowledge = resolve
    })
  )
  const settled = vi.fn()
  const handle = sendNativeChatMessage(null, 'pane', 'answer', { onDeliverySettled: settled })
  handle.cancel()
  acknowledge(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(settled).not.toHaveBeenCalled()
  expect(io.verified).toHaveBeenCalledOnce()
})
