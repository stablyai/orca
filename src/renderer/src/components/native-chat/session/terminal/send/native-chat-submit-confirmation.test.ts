import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifiedInput = vi.hoisted(() => vi.fn(async () => true))
const plainInput = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: verifiedInput
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: plainInput
}))

import {
  composerStillHoldsSubmittedText,
  NATIVE_CHAT_SUBMIT_CONFIRM_MS,
  sendNativeChatObservedWrites
} from './native-chat-observed-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'

const ENTER_DELAY_MS = 500

function sendPrompt(options: Parameters<typeof sendNativeChatObservedWrites>[2]) {
  const onDeliverySettled = vi.fn()
  const handle = sendNativeChatObservedWrites(
    'pty-1',
    [
      { data: 'body', delayBeforeMs: 0 },
      { data: '\r', delayBeforeMs: ENTER_DELAY_MS }
    ],
    { onWriteRejected: vi.fn(), onDeliverySettled, ...options }
  )
  return { handle, onDeliverySettled }
}

describe('native chat submit confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    verifiedInput.mockClear()
    plainInput.mockClear()
  })

  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    vi.useRealTimers()
  })

  it('keeps the send when the agent consumed Enter and the composer is empty', async () => {
    let line = ''
    const { handle, onDeliverySettled } = sendPrompt({
      readInputLine: () => line,
      submittedText: 'hello'
    })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)

    await expect(handle.outcome).resolves.toBe('submitted')
    expect(onDeliverySettled).toHaveBeenLastCalledWith(true)
    expect(verifiedInput).toHaveBeenCalledTimes(2)
  })

  it('presses Enter again when the composer still holds the message, then settles', async () => {
    let line = 'hello'
    const { handle } = sendPrompt({ readInputLine: () => line, submittedText: 'hello' })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)
    expect(verifiedInput).toHaveBeenCalledTimes(3)
    line = ''
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)

    await expect(handle.outcome).resolves.toBe('submitted')
  })

  it('marks the send not submitted when the text survives the second Enter', async () => {
    const { handle, onDeliverySettled } = sendPrompt({
      readInputLine: () => 'hello',
      submittedText: 'hello'
    })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)

    await expect(handle.outcome).resolves.toBe('not-submitted')
    expect(onDeliverySettled).toHaveBeenLastCalledWith(false)
  })

  it('leaves an unreadable composer best-effort', async () => {
    const { handle } = sendPrompt({ readInputLine: () => null, submittedText: 'hello' })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)

    await expect(handle.outcome).resolves.toBe('submitted')
    expect(verifiedInput).toHaveBeenCalledTimes(2)
  })

  it('retries Enter when the composer shows a collapsed paste label', async () => {
    let line = '[Pasted text #1 +29 lines]'
    const { handle } = sendPrompt({
      readInputLine: () => line,
      submittedText: 'line one\nline two'
    })
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)
    // The label may stand for our text, so the dropped Enter is retried rather than settling silently.
    expect(verifiedInput).toHaveBeenCalledTimes(3)

    line = ''
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_CONFIRM_MS)
    await expect(handle.outcome).resolves.toBe('submitted')
  })
})

describe('composerStillHoldsSubmittedText', () => {
  it('normalizes whitespace and matches long pastes by an edge', () => {
    expect(composerStillHoldsSubmittedText('  hello\nworld ', 'hello world')).toBe(true)
    const long = `${'a'.repeat(80)} tail-marker`
    expect(composerStillHoldsSubmittedText('prefix ... tail-marker', long)).toBe(true)
    expect(composerStillHoldsSubmittedText('', 'hello')).toBe(false)
    expect(composerStillHoldsSubmittedText(null, 'hello')).toBe(false)
    expect(composerStillHoldsSubmittedText('a different draft', 'hello')).toBe(false)
  })

  it('does not claim an image-only send is still held', () => {
    // An image placeholder is not the sent text; matching it would press Enter a second time.
    expect(composerStillHoldsSubmittedText('[image]', '')).toBe(false)
    expect(composerStillHoldsSubmittedText('[image]', '   ')).toBe(false)
  })

  it('treats a collapsed paste label as possibly holding the sent text', () => {
    // Claude folds a multiline paste into a label, so absence of the full text proves nothing.
    expect(
      composerStillHoldsSubmittedText('[Pasted text #1 +29 lines]', 'line one\nline two\nline three')
    ).toBe(true)
  })
})
