// Send-path behaviour when a launch-context draft is still parked on the agent's
// TUI input line: the multi-line clear and its confirmation step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn()
const sendRuntimePtyInputVerified = vi.fn()
const sendRuntimeAgentPrompt = vi.fn()
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimeAgentPrompt: (...args: unknown[]) => sendRuntimeAgentPrompt(...args),
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
import { cancelNativeChatPtySends, enqueueNativeChatPtySend } from './native-chat-pty-send-queue'

const SETTINGS = {} as Parameters<typeof sendNativeChatMessage>[0]
const PTY = 'pty-launch-draft'
const DRAFT = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123'

const writes = (): string[] => sendRuntimePtyInput.mock.calls.map((call) => call[2] as string)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: true,
    location: { pathname: '/web-index.html' }
  })
  sendRuntimePtyInput.mockClear()
  sendRuntimePtyInput.mockReturnValue(true)
  sendRuntimePtyInputVerified.mockReset()
  sendRuntimePtyInputVerified.mockResolvedValue(true)
  sendRuntimeAgentPrompt.mockReset()
  sendRuntimeAgentPrompt.mockResolvedValue(true)
  resetNativeChatPtySendQueuesForTests()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetNativeChatPtySendQueuesForTests()
})

it('aborts an unsubmitted queue entry signal when the entry is cancelled', async () => {
  let entrySignal: AbortSignal | undefined
  const handle = enqueueNativeChatPtySend(PTY, NATIVE_CHAT_SUBMIT_DELAY_MS, ({ signal }) => {
    entrySignal = signal
  })

  handle.cancel()

  expect(entrySignal?.aborted).toBe(true)
  await handle.settled
})

describe('sendNativeChatMessage with a parked multi-line draft', () => {
  it('keeps the draft raw, then submits the edited Web prompt through one semantic call', async () => {
    const remotePty = 'remote:env-1@@term-1'
    const handle = sendNativeChatMessage(SETTINGS, remotePty, 'edited text', {
      clearInput: buildAgentTuiClearInputForText(DRAFT),
      confirmCleared: () => true,
      agentPrompt: true
    })

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_CLEAR_CONFIRM_MS)

    expect(sendRuntimePtyInputVerified).toHaveBeenCalledWith(
      SETTINGS,
      remotePty,
      buildAgentTuiClearInputForText(DRAFT)
    )
    expect(sendRuntimeAgentPrompt).toHaveBeenCalledWith(
      SETTINGS,
      remotePty,
      'edited text',
      expect.any(AbortSignal)
    )
    expect(sendRuntimePtyInput).not.toHaveBeenCalledWith(
      SETTINGS,
      remotePty,
      expect.stringContaining('edited text')
    )
    await expect(handle.accepted).resolves.toBe(true)
  })

  it('reports a rejected semantic submission without falling back to raw prompt bytes', async () => {
    sendRuntimeAgentPrompt.mockResolvedValue(false)
    const remotePty = 'remote:env-1@@term-1'
    const handle = sendNativeChatMessage(SETTINGS, remotePty, 'edited text', {
      agentPrompt: true
    })

    await expect(handle.accepted).resolves.toBe(false)
    expect(sendRuntimePtyInput).not.toHaveBeenCalledWith(
      SETTINGS,
      remotePty,
      expect.stringContaining('edited text')
    )
  })

  it('aborts semantic delivery when the PTY queue cancels the send internally', async () => {
    let requestSignal: AbortSignal | undefined
    sendRuntimeAgentPrompt.mockImplementation(
      (_settings: unknown, _ptyId: unknown, _text: unknown, signal: AbortSignal) => {
        requestSignal = signal
        return new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
      }
    )
    const remotePty = 'remote:env-1@@term-1'
    const handle = sendNativeChatMessage(SETTINGS, remotePty, 'edited text', {
      agentPrompt: true
    })
    await Promise.resolve()
    await Promise.resolve()

    cancelNativeChatPtySends(remotePty)

    expect(requestSignal?.aborted).toBe(true)
    await expect(handle.accepted).resolves.toBe(false)
  })

  it('keeps a remote Electron composer on the existing raw byte path', async () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = false
    window.location.pathname = '/index.html'
    const remotePty = 'remote:env-1@@term-1'
    const handle = sendNativeChatMessage(SETTINGS, remotePty, 'desktop text', {
      agentPrompt: true
    })

    expect(handle.accepted).toBeUndefined()
    expect(sendRuntimeAgentPrompt).not.toHaveBeenCalled()
    expect(writes()).toContain(buildNativeChatPasteBytes('desktop text'))
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS)
    expect(writes()).toContain(NATIVE_CHAT_SUBMIT)
  })

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
  it('does not claim semantic Agent-prompt delivery for an image-only send', async () => {
    const handle = sendNativeChatMessageWithImageAttachments(
      SETTINGS,
      'remote:env-1@@term-1',
      '',
      ['/tmp/a.png'],
      { agentPrompt: true }
    )

    await vi.runAllTimersAsync()
    await handle.settled

    expect(sendRuntimeAgentPrompt).not.toHaveBeenCalled()
    expect(handle.accepted).toBeUndefined()
  })

  it('submits an image caption through the semantic Agent-prompt boundary', async () => {
    const handle = sendNativeChatMessageWithImageAttachments(
      SETTINGS,
      'remote:env-1@@term-1',
      'caption',
      ['/tmp/a.png'],
      { agentPrompt: true }
    )

    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)

    expect(sendRuntimeAgentPrompt).toHaveBeenCalledWith(
      SETTINGS,
      'remote:env-1@@term-1',
      'caption',
      expect.any(AbortSignal)
    )
    await expect(handle.accepted).resolves.toBe(true)
  })

  it('aborts image-caption delivery when the PTY queue cancels internally', async () => {
    let requestSignal: AbortSignal | undefined
    sendRuntimeAgentPrompt.mockImplementation(
      (_settings: unknown, _ptyId: unknown, _text: unknown, signal: AbortSignal) => {
        requestSignal = signal
        return new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
      }
    )
    const remotePty = 'remote:env-1@@term-1'
    const handle = sendNativeChatMessageWithImageAttachments(
      SETTINGS,
      remotePty,
      'caption',
      ['/tmp/a.png'],
      { agentPrompt: true }
    )
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)

    cancelNativeChatPtySends(remotePty)

    expect(requestSignal?.aborted).toBe(true)
    await expect(handle.accepted).resolves.toBe(false)
  })

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
