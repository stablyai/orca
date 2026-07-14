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
  sendNativeChatAnswer,
  nativeChatQuestionOffsets,
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

describe('nativeChatQuestionOffsets', () => {
  it('paces each question a full step apart, Enter 500ms after its body', () => {
    expect(NATIVE_CHAT_QUESTION_STEP_MS).toBe(1000)
    expect(NATIVE_CHAT_ADVANCE_BUFFER_MS).toBe(500)
    expect(nativeChatQuestionOffsets(0)).toEqual({ bodyAt: 0, enterAt: 500 })
    expect(nativeChatQuestionOffsets(1)).toEqual({ bodyAt: 1000, enterAt: 1500 })
    expect(nativeChatQuestionOffsets(2)).toEqual({ bodyAt: 2000, enterAt: 2500 })
  })
})

describe('sendNativeChatAnswer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendRuntimePtyInput.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('single-line answer behaves exactly like sendNativeChatMessage', () => {
    sendNativeChatAnswer(SETTINGS, PTY, ['only one'])
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('only one')
    )
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)
  })

  it('multi-line: 3 bodies + 3 Enters in order, each Enter 500ms after its body, next body only after prior Enter+buffer', () => {
    const lines = ['answer one', 'answer two', 'answer three']
    const handle = sendNativeChatAnswer(SETTINGS, PTY, lines)

    expect(handle.settleAfterMs).toBe(nativeChatQuestionOffsets(lines.length - 1).enterAt)

    // Nothing fires synchronously: even question 0's body is scheduled (setTimeout 0).
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(0)

    // t=0: question 0 body.
    vi.advanceTimersByTime(0)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('answer one')
    )

    // t=500: question 0 Enter (500ms after its body); question 1 body NOT yet.
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)

    // Question 1 body must wait the advance buffer past question 0's Enter.
    vi.advanceTimersByTime(NATIVE_CHAT_ADVANCE_BUFFER_MS - 1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(2)

    // t=800: question 1 body.
    vi.advanceTimersByTime(1)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(3)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('answer two')
    )

    // t=1300: question 1 Enter.
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(4)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)

    // t=1600: question 2 body.
    vi.advanceTimersByTime(NATIVE_CHAT_ADVANCE_BUFFER_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(5)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(
      SETTINGS,
      PTY,
      buildNativeChatPasteBytes('answer three')
    )

    // t=2100: question 2 Enter — the final submit. No trailing writes after.
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(6)
    expect(sendRuntimePtyInput).toHaveBeenLastCalledWith(SETTINGS, PTY, NATIVE_CHAT_SUBMIT)

    // Exactly 3 bodies + 3 Enters; running all timers adds nothing more.
    vi.runAllTimers()
    expect(sendRuntimePtyInput).toHaveBeenCalledTimes(6)

    // Verify body/Enter ordering across the whole sequence.
    const calls = sendRuntimePtyInput.mock.calls.map((c) => c[2])
    expect(calls).toEqual([
      buildNativeChatPasteBytes('answer one'),
      NATIVE_CHAT_SUBMIT,
      buildNativeChatPasteBytes('answer two'),
      NATIVE_CHAT_SUBMIT,
      buildNativeChatPasteBytes('answer three'),
      NATIVE_CHAT_SUBMIT
    ])
  })
})
