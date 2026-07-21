import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the IO seam so the test stays pure: we only assert the write order and
// the inter-write delay, not the local-vs-remote pty branching.
const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import {
  sendNativeChatMessage,
  sendNativeChatMessageVerified,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt,
  sendNativeChatAskAnswer,
  resetNativeChatPtySendQueuesForTests,
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_ADVANCE_BUFFER_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
} from './native-chat-runtime-send'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'

const SETTINGS = {} as Parameters<typeof sendNativeChatMessage>[0]
const PTY = 'pty-1'

function expectWriteOrder(calls: unknown[][], expected: string[]): void {
  expect(calls.map((call) => call[2])).toEqual(expected)
}

describe('sendNativeChatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    resetNativeChatPtySendQueuesForTests()
    sendRuntimePtyInput.mockReturnValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('clears the TUI line, then writes the framed body, before the Enter', () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'hello world')
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hello world')
    ])
    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)
  })

  it('does not fire Enter before the proven 500ms gap (busy-agent safety)', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'hi')
    // A short gap would fire Enter while a busy Codex has not yet landed the
    // paste, submitting an empty box — so nothing must happen before 500ms.
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
  })

  it('writes the bare carriage-return Enter as a separate delayed write', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'hi')
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hi'),
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('cancels the delayed Enter and re-clears an unsubmitted body', () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'hi')
    handle.cancel()
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)

    // Pre-send clear + body + cancel clear; Enter must not fire.
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('hi'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
    ])
  })

  it('clears leftover unsubmitted body on cancel so the next send cannot glue', async () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'tell me a joke')
    handle.cancel()

    sendNativeChatMessage(SETTINGS, PTY, 'continue')
    // Queue release after cancel is promise-chained; flush so the next body runs.
    await Promise.resolve()
    await Promise.resolve()

    expect(sendRuntimePtyInput.mock.calls.map((call) => call[2])).toEqual([
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, // cancel cleanup
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT, // next send pre-clear
      buildNativeChatPasteBytes('continue')
    ])
  })

  it('does not clear the TUI input when cancel runs after Enter already fired', () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'already submitted')
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    sendRuntimePtyInput.mockClear()
    handle.cancel()

    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('matches orca-runtime writeTerminalAction Enter gap (500ms)', () => {
    expect(NATIVE_CHAT_SUBMIT_DELAY_MS).toBe(500)
  })

  it('serializes rapid sends on the same PTY so bodies cannot glue before Enter', async () => {
    sendNativeChatMessage(SETTINGS, PTY, 'tell me a joke')
    sendNativeChatMessage(SETTINGS, PTY, 'continue')

    // First clear+body are immediate; second sequence waits for the first Enter.
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke')
    ])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('tell me a joke'),
      NATIVE_CHAT_SUBMIT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('continue')
    ])

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(6)
  })

  it('does not serialize sends across different PTYs', () => {
    sendNativeChatMessage(SETTINGS, 'pty-a', 'one')
    sendNativeChatMessage(SETTINGS, 'pty-b', 'two')
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('one'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('two')
    ])
    expect(sendRuntimePtyInput.mock.calls[1]?.[1]).toBe('pty-a')
    expect(sendRuntimePtyInput.mock.calls[3]?.[1]).toBe('pty-b')
  })
})

describe('sendNativeChatMessageVerified', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInputVerified.mockReset().mockResolvedValue(true)
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('awaits body acceptance before the delayed Enter write (no pre-clear)', async () => {
    // Why: model-switch confirmation watches the PTY while this send runs;
    // verified option commands must not inject Ctrl+U noise.
    const result = sendNativeChatMessageVerified(SETTINGS, PTY, '/model sonnet')
    await vi.waitFor(() => {
      expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    })
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('/model sonnet')
    )

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(await result).toBe(true)
    expect(sendRuntimePtyInputVerified).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
    expect(
      sendRuntimePtyInputVerified.mock.calls.some(
        (call) => call[2] === NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
      )
    ).toBe(false)
  })

  it('does not send Enter when the body is rejected', async () => {
    sendRuntimePtyInputVerified.mockResolvedValueOnce(false)

    await expect(sendNativeChatMessageVerified(SETTINGS, PTY, '/model sonnet')).resolves.toBe(false)
    await vi.runAllTimersAsync()

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    expect(
      sendRuntimePtyInputVerified.mock.calls.some((call) => call[2] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })

  it('cancels an in-flight chat Enter before delivering a verified option command', async () => {
    sendNativeChatMessage(SETTINGS, PTY, 'hello')
    expect(sendRuntimePtyInput).toHaveBeenCalled()

    const result = sendNativeChatMessageVerified(SETTINGS, PTY, '/model haiku')
    // Chat cancel may Ctrl+U the unsubmitted body; Enter from chat must not fire.
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(await result).toBe(true)
    const submits = sendRuntimePtyInput.mock.calls.filter((call) => call[2] === NATIVE_CHAT_SUBMIT)
    // Only the verified path's Enter — chat's delayed Enter was cancelled.
    expect(submits).toHaveLength(0)
    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('returns false when the delayed Enter wait is aborted', async () => {
    const controller = new AbortController()
    const result = sendNativeChatMessageVerified(SETTINGS, PTY, '/model sonnet', controller.signal)
    await vi.waitFor(() => {
      expect(sendRuntimePtyInputVerified).toHaveBeenCalledTimes(1)
    })
    controller.abort()

    expect(await result).toBe(false)
    expect(
      sendRuntimePtyInputVerified.mock.calls.some((call) => call[2] === NATIVE_CHAT_SUBMIT)
    ).toBe(false)
  })
})

describe('sendNativeChatMessageWithImageAttachments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    resetNativeChatPtySendQueuesForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetNativeChatPtySendQueuesForTests()
  })

  it('clears the line, then bracket-pastes image paths before prompt text', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'what do you see?', [
      '/tmp/orca-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(
      NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatImagePasteBytes('/tmp/orca-paste-image.png')
    ])

    vi.advanceTimersByTime(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('what do you see?')
    )

    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(4)
  })

  it('waits the normal submit gap for an attachment-only send', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, '', [
      '/tmp/orca-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatImagePasteBytes('/tmp/orca-paste-image.png')
    ])

    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(3)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('cancels deferred prompt and Enter writes after the attachment path', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'describe', [
      '/tmp/orca-paste-image.png'
    ])
    handle.cancel()
    vi.runAllTimers()

    // Pre-clear + image body + cancel clear; no Enter.
    expectWriteOrder(sendRuntimePtyInput.mock.calls, [
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatImagePasteBytes('/tmp/orca-paste-image.png'),
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
    ])
    expect(sendRuntimePtyInput.mock.calls.some((call) => call[2] === NATIVE_CHAT_SUBMIT)).toBe(
      false
    )
  })
})

describe('empty prompt submit', () => {
  beforeEach(() => {
    sendRuntimePtyInput.mockClear()
  })

  it('submits an empty prompt with a bare Enter', () => {
    submitNativeChatPrompt(SETTINGS, PTY)
    expect(sendRuntimePtyInput).toHaveBeenCalledOnce()
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })
})

describe('sendNativeChatAskAnswer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
    sendRuntimePtyInput.mockReturnValue(true)
    sendRuntimePtyInputVerified.mockReset().mockResolvedValue(true)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a no-op handle for an empty key group list', () => {
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [])
    expect(handle.settleAfterMs).toBe(0)
    handle.cancel()
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('paces key groups so selector steps render before the next write', () => {
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [
      { raw: '1' },
      { raw: '2' },
      { text: 'custom answer' }
    ])
    expect(handle.settleAfterMs).toBe(
      2 * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(SETTINGS, PTY, '1')

    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(SETTINGS, PTY, '2')

    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('custom answer')
    )
  })

  it('cancels remaining key group timers', () => {
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '1' }, { raw: '2' }])
    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    handle.cancel()
    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS * 2)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })

  it('reports verified delivery only after settling and suppresses it after cancellation', async () => {
    const onSettled = vi.fn()
    sendRuntimePtyInputVerified.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '1' }, { raw: '\r' }], onSettled)

    await vi.advanceTimersByTimeAsync(handle.settleAfterMs)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false)
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()

    const canceledSettled = vi.fn()
    const canceled = sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '1' }], canceledSettled)
    canceled.cancel()
    await vi.runAllTimersAsync()
    expect(canceledSettled).not.toHaveBeenCalled()
  })

  it('waits for remote acceptance before reporting delivery', async () => {
    const onSettled = vi.fn()
    let resolveAccepted!: (accepted: boolean) => void
    sendRuntimePtyInputVerified.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveAccepted = resolve
      })
    )

    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '2' }], onSettled)
    await vi.advanceTimersByTimeAsync(handle.settleAfterMs)

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(SETTINGS, PTY, '2')
    expect(onSettled).not.toHaveBeenCalled()

    resolveAccepted(true)
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledExactlyOnceWith(true))
  })
})

describe('constants', () => {
  it('exports the ask-answer advance buffer used by interactive cards', () => {
    expect(NATIVE_CHAT_ADVANCE_BUFFER_MS).toBeGreaterThan(0)
  })
})
