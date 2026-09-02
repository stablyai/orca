// Send-path behaviour when a launch-context draft is still parked on the agent's
// TUI input line: the multi-line clear and its confirmation step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...args),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...args)
}))

import {
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage
} from './native-chat-runtime-send'
import {
  NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS,
  sendNativeChatMessageWithImageAttachments
} from './native-chat-runtime-image-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'
import {
  AGENT_TUI_CLEAR_INPUT_MAX,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-tui-input-clear'

const SETTINGS = {} as Parameters<typeof sendNativeChatMessage>[0]
const PTY = 'pty-launch-draft'
const DRAFT = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

const writes = (): string[] => sendRuntimePtyInput.mock.calls.map((call) => call[2] as string)

beforeEach(() => {
  vi.useFakeTimers()
  sendRuntimePtyInput.mockClear()
  sendRuntimePtyInput.mockReturnValue(true)
  resetNativeChatPtySendQueuesForTests()
})
afterEach(() => {
  vi.useRealTimers()
  resetNativeChatPtySendQueuesForTests()
})

describe('sendNativeChatMessage with a parked multi-line draft', () => {
  it('leads with a clear sized to every line of the draft, not one Ctrl+U', () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(SETTINGS, PTY, 'edited text', { clearInput })
    expect(writes()).toEqual([clearInput, buildNativeChatPasteBytes('edited text')])
    expect(clearInput).not.toBe(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
  })

  it('still defaults to a single Ctrl+U when no draft is parked', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'plain')
    expect(writes()[0]).toBe(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
  })

  it('holds the body until the clear is confirmed, then submits after the gap', () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(SETTINGS, PTY, 'edited', {
      clearInput,
      confirmCleared: () => true
    })
    // Body must NOT ride out with the clear — the confirm happens in between.
    expect(writes()).toEqual([clearInput])
    vi.advanceTimersByTime(NATIVE_CHAT_CLEAR_CONFIRM_MS)
    expect(writes()).toEqual([clearInput, buildNativeChatPasteBytes('edited')])
    vi.advanceTimersByTime(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(writes()).toEqual([clearInput, buildNativeChatPasteBytes('edited'), NATIVE_CHAT_SUBMIT])
  })

  it('preserves the body-to-Enter gap when the renderer stalls past both nominal deadlines', async () => {
    vi.useRealTimers()
    const writeTimes = new Map<string, number>()
    sendRuntimePtyInput.mockImplementation((_settings, _pty, bytes: string) => {
      writeTimes.set(bytes, performance.now())
      return true
    })
    sendNativeChatMessage(SETTINGS, PTY, 'edited', {
      clearInput: buildAgentTuiClearInputForText(DRAFT),
      confirmCleared: () => true
    })
    sendNativeChatMessage(SETTINGS, PTY, 'queued')

    const blockedUntil =
      performance.now() + NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS + 50
    while (performance.now() < blockedUntil) {
      // Simulate a renderer long task delaying both nominal deadlines.
    }

    await vi.waitFor(() => expect(writeTimes.has(NATIVE_CHAT_SUBMIT)).toBe(true), {
      timeout: NATIVE_CHAT_SUBMIT_DELAY_MS + 1_000
    })
    await vi.waitFor(() => expect(writeTimes.has(buildNativeChatPasteBytes('queued'))).toBe(true))
    expect(
      writeTimes.get(NATIVE_CHAT_SUBMIT)! - writeTimes.get(buildNativeChatPasteBytes('edited'))!
    ).toBeGreaterThanOrEqual(NATIVE_CHAT_SUBMIT_DELAY_MS - 20)
    expect(writes().indexOf(NATIVE_CHAT_SUBMIT)).toBeLessThan(
      writes().indexOf(buildNativeChatPasteBytes('queued'))
    )
  })

  it('widens to a maximal burst when the draft is still observed on the line', () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(SETTINGS, PTY, 'edited', {
      clearInput,
      confirmCleared: () => false
    })
    vi.advanceTimersByTime(NATIVE_CHAT_CLEAR_CONFIRM_MS)
    expect(writes()).toEqual([
      clearInput,
      AGENT_TUI_CLEAR_INPUT_MAX,
      buildNativeChatPasteBytes('edited')
    ])
  })

  it('re-clears before the body, never after it', () => {
    sendNativeChatMessage(SETTINGS, PTY, 'edited', {
      clearInput: buildAgentTuiClearInputForText(DRAFT),
      confirmCleared: () => false
    })
    vi.advanceTimersByTime(NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS)
    const order = writes()
    expect(order.indexOf(AGENT_TUI_CLEAR_INPUT_MAX)).toBeLessThan(
      order.indexOf(buildNativeChatPasteBytes('edited'))
    )
  })

  it('charges the confirm gap to the handle so the send card outlives the Enter', () => {
    const withConfirm = sendNativeChatMessage(SETTINGS, PTY, 'a', {
      clearInput: '\x15',
      confirmCleared: () => true
    })
    expect(withConfirm.settleAfterMs).toBe(
      NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_CLEAR_CONFIRM_MS
    )
  })

  it('submits before a queued send starts after clear confirmation', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessage(SETTINGS, PTY, 'first', {
      clearInput,
      confirmCleared: () => true
    })
    sendNativeChatMessage(SETTINGS, PTY, 'second')

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_CLEAR_CONFIRM_MS + NATIVE_CHAT_SUBMIT_DELAY_MS)

    expect(writes()).toEqual([
      clearInput,
      buildNativeChatPasteBytes('first'),
      NATIVE_CHAT_SUBMIT,
      NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
      buildNativeChatPasteBytes('second')
    ])
  })
})

describe('image sends with a parked multi-line draft', () => {
  it('clears every draft line before pasting, so no line rides along with the image', () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'caption', ['/tmp/a.png'], {
      clearInput
    })
    expect(writes()[0]).toBe(clearInput)
  })

  it('clears exactly once — a second Ctrl+U would wipe the just-pasted image', () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'caption', ['/tmp/a.png'], {
      clearInput
    })
    vi.advanceTimersByTime(10_000)
    expect(writes().filter((write) => write === clearInput)).toHaveLength(1)
  })

  it('submits the image send before a queued message starts', async () => {
    const clearInput = buildAgentTuiClearInputForText(DRAFT)
    sendNativeChatMessageWithImageAttachments(SETTINGS, PTY, 'caption', ['/tmp/a.png'], {
      clearInput,
      confirmCleared: () => true
    })
    sendNativeChatMessage(SETTINGS, PTY, 'second')

    await vi.advanceTimersByTimeAsync(
      NATIVE_CHAT_CLEAR_CONFIRM_MS +
        NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS +
        NATIVE_CHAT_SUBMIT_DELAY_MS
    )

    expect(writes().indexOf(NATIVE_CHAT_SUBMIT)).toBeLessThan(
      writes().indexOf(NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT)
    )
  })
})
