import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the IO seam so the test stays pure: we only assert the write order and
// the inter-write delay, not the local-vs-remote pty branching.
const sendRuntimePtyInput = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args)
}))

import {
  sendNativeChatMessage,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt,
  sendNativeChatAskAnswer,
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
  NATIVE_CHAT_ADVANCE_BUFFER_MS
} from './native-chat-runtime-send'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'

const SETTINGS = {} as Parameters<typeof sendNativeChatMessage>[0]
const PTY = 'pty-1'

describe('sendNativeChatMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the framed body immediately, before the Enter', () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'hello world')
    // Body lands synchronously; Enter is still pending on the timer.
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('hello world')
    )
    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)
  })

  it('does not fire Enter before the proven 500ms gap (busy-agent safety)', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'hi')
    // A short gap would fire Enter while a busy Codex has not yet landed the
    // paste, submitting an empty box — so nothing must happen before 500ms.
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })

  it('writes the bare carriage-return Enter as a separate delayed write', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'hi')
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('cancels the delayed Enter when its owning composer is detached', () => {
    const handle = sendNativeChatMessage(SETTINGS, PTY, 'hi')
    handle.cancel()
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })

  it('matches orca-runtime writeTerminalAction Enter gap (500ms)', () => {
    expect(NATIVE_CHAT_SUBMIT_DELAY_MS).toBe(500)
  })
})

describe('sendNativeChatMessageWithImageAttachments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bracket-pastes image paths before prompt text so the TUI creates image chips', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'what do you see?', [
      '/tmp/orca-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(
      NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatImagePasteBytes('/tmp/orca-paste-image.png')
    )

    vi.advanceTimersByTime(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('what do you see?')
    )

    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(3)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('waits the normal submit gap for an attachment-only send', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, '', [
      '/tmp/orca-paste-image.png'
    ])

    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)

    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('cancels deferred prompt and Enter writes after the attachment path', () => {
    const handle = sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'describe', [
      '/tmp/orca-paste-image.png'
    ])
    handle.cancel()
    vi.runAllTimers()

    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })
})

describe('empty prompt submit', () => {
  beforeEach(() => {
    sendRuntimePtyInput.mockClear()
  })

  it('submits an empty prompt with a bare Enter', () => {
    submitNativeChatPrompt(SETTINGS, PTY)

    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })
})

describe('sendNativeChatAskAnswer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('paces each keystroke a full step apart (the proven submit gap + advance buffer)', () => {
    expect(NATIVE_CHAT_QUESTION_STEP_MS).toBe(1000)
    expect(NATIVE_CHAT_ADVANCE_BUFFER_MS).toBe(500)
  })

  it('no writes and 0 settle for an empty keystroke list', () => {
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [])
    expect(handle.settleAfterMs).toBe(0)
    vi.runAllTimers()
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(0)
  })

  it('single option-number keystroke: fires at t=0, settles a submit gap later', () => {
    // The STA-1860 fix: a lone single-select pick is delivered as the option
    // NUMBER, with no trailing Enter (the number both selects and commits).
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [{ raw: '2' }])
    expect(handle.settleAfterMs).toBe(NATIVE_CHAT_SUBMIT_DELAY_MS)

    // Scheduled at t=0 (setTimeout 0), not written synchronously.
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(0)
    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, '2')
    vi.runAllTimers()
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })

  it('writes each group a step apart; text groups go through the paste framer', () => {
    const groups = [{ raw: '3' }, { text: 'custom answer' }, { raw: '\r' }]
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, groups)
    expect(handle.settleAfterMs).toBe(
      2 * NATIVE_CHAT_QUESTION_STEP_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, '3')

    // The next group must wait a full step so the "Type something" row renders.
    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('custom answer')
    )

    vi.advanceTimersByTime(NATIVE_CHAT_QUESTION_STEP_MS)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)

    vi.runAllTimers()
    const calls = sendRuntimePtyInput.mock.calls.map((c) => c[2])
    expect(calls).toEqual(['3', buildNativeChatPasteBytes('custom answer'), NATIVE_CHAT_SUBMIT])
  })

  it('cancel clears every pending keystroke', () => {
    const handle = sendNativeChatAskAnswer(SETTINGS, PTY, [
      { raw: '1' },
      { raw: '\x1b[C' },
      { raw: '\r' }
    ])
    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    handle.cancel()
    vi.runAllTimers()
    // Only the first keystroke landed; the rest were cancelled.
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
  })
})
