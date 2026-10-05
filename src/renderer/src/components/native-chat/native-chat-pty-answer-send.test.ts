import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
import { formatAsyncQuestionReply } from '../../../../shared/native-chat-async-questions'
import { sendNativeChatMessageWithOutcome } from './native-chat-pty-answer-send'
import { cancelNativeChatPtySends, holdNativeChatPtyForOption } from './native-chat-pty-send-queue'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-runtime-send'
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

function start(text = 'answer') {
  const started = sendNativeChatMessageWithOutcome(null, 'codex-pane', text)
  if (!started) {
    throw new Error('expected the send to start')
  }
  return started
}

it('settles accepted once the body and Enter were both accepted', async () => {
  const { outcome } = start()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('accepted')
})

it('settles rejected when the host refuses the write (Codex included)', async () => {
  io.verified.mockResolvedValueOnce(false)
  const { outcome } = start()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('rejected')
  expect(io.verified.mock.calls.map((call) => call[2])).not.toContain(NATIVE_CHAT_SUBMIT)
})

it('settles unknown when the acknowledgement was lost', async () => {
  io.verified.mockRejectedValueOnce(new Error('lost'))
  const { outcome } = start()
  await vi.advanceTimersByTimeAsync(120_000)
  await expect(outcome).resolves.toBe('unknown')
})

it('settles rejected when cancelled before Enter', async () => {
  const { handle, outcome } = start()
  handle.cancel()
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('rejected')
})

it('delivers a slash-titled answer as an ordinary pasted message, never a typed command', async () => {
  const text = formatAsyncQuestionReply([{ title: '/model', answer: 'gpt-5' }])
  const { outcome } = start(text)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('accepted')
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('Question: /model\nAnswer: gpt-5'),
    NATIVE_CHAT_SUBMIT
  ])
})

it('settles rejected when an option command drains the queue before Enter', async () => {
  const { outcome } = start()
  await vi.advanceTimersByTimeAsync(100)
  cancelNativeChatPtySends('codex-pane')
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('rejected')
  expect(io.verified.mock.calls.map((call) => call[2])).not.toContain(NATIVE_CHAT_SUBMIT)
})

it('stays accepted when a cancel arrives after Enter fired', async () => {
  const { outcome } = start()
  await vi.advanceTimersByTimeAsync(1000)
  cancelNativeChatPtySends('codex-pane')
  await expect(outcome).resolves.toBe('accepted')
})

it('settles unknown, not rejected, when a cancel lands after Enter went out but before its ack', async () => {
  let ackEnter: (accepted: boolean) => void = () => {}
  io.verified.mockImplementation((_settings: unknown, _pty: string, data: string) =>
    data === NATIVE_CHAT_SUBMIT
      ? new Promise<boolean>((resolve) => {
          ackEnter = resolve
        })
      : Promise.resolve(true)
  )
  const { handle, outcome } = start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.verified.mock.calls.map((call) => call[2])).toContain(NATIVE_CHAT_SUBMIT)
  // Stop, an option command's drain or a PTY swap: the Enter bytes already reached the runtime.
  handle.cancel()
  ackEnter(true)
  await vi.advanceTimersByTimeAsync(1000)
  await expect(outcome).resolves.toBe('unknown')
})

it('refuses to start while an option command owns the PTY', () => {
  const release = holdNativeChatPtyForOption('codex-pane')
  expect(sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')).toBeNull()
  expect(io.verified).not.toHaveBeenCalled()
  release()
  expect(sendNativeChatMessageWithOutcome(null, 'codex-pane', 'answer')).not.toBeNull()
})
