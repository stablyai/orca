import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writes } = vi.hoisted((): { writes: string[] } => ({ writes: [] }))

vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: (_ptyId: string, data: string) => {
    writes.push(data)
    return true
  }
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (_ptyId: string, data: string) => {
    writes.push(data)
    return Promise.resolve(true)
  }
}))

import { sendNativeChatMessage } from './native-chat-runtime-send'
import {
  cancelNativeChatPtySends,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'
import { nativeChatExpectedLine, nativeChatLineShowsMessage } from './native-chat-paste-landed'

const CTRL_U = '\x15'

describe('sendNativeChatMessage input line ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writes.length = 0
  })

  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    vi.useRealTimers()
  })

  // Claude takes a clear that shares its read with the message as pasted text, so the old line joined the message.
  it('writes the message only after the clear emptied the input line', async () => {
    let line = 'Existing draft'
    const handle = sendNativeChatMessage('pty-1', '/model opus', {
      clearInput: CTRL_U.repeat(3),
      readInputLine: () => line,
      onWriteRejected: () => {}
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([CTRL_U.repeat(3)])

    line = ''
    await vi.advanceTimersByTimeAsync(200)
    expect(writes).toEqual([CTRL_U.repeat(3), '/model opus'])

    line = '/model opus'
    await vi.advanceTimersByTimeAsync(600)
    expect(writes).toEqual([CTRL_U.repeat(3), '/model opus', '\r'])
    await expect(handle.outcome).resolves.toBe('submitted')
  })

  // Enter that arrives while the agent is still reading the paste becomes part of it.
  it('presses Enter only once the input line shows the whole pasted message', async () => {
    let line = ''
    sendNativeChatMessage('pty-1', 'Reply with PONG', {
      readInputLine: () => line,
      onWriteRejected: () => {}
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes).toEqual(['Reply with PONG'])

    line = 'Reply with'
    await vi.advanceTimersByTimeAsync(300)
    expect(writes).toEqual(['Reply with PONG'])

    line = 'Reply with PONG'
    await vi.advanceTimersByTimeAsync(100)

    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual(['Reply with PONG', '\r'])
  })

  // A session command cancelling the queue used to leave the message looking sent.
  it('reports a send cancelled by a session command as not sent, but not its own cancel', async () => {
    const rejected: string[] = []
    const first = sendNativeChatMessage('pty-1', 'first', {
      clearInput: '',
      onWriteRejected: () => rejected.push('first')
    })
    const second = sendNativeChatMessage('pty-1', 'second', {
      clearInput: '',
      onWriteRejected: () => rejected.push('second')
    })
    first.cancel()
    cancelNativeChatPtySends('pty-1')
    await expect(second.outcome).resolves.toBe('not-submitted')
    expect(rejected).toEqual(['second'])
  })
})

describe('nativeChatLineShowsMessage', () => {
  it('accepts a long token the agent wrapped across rows', () => {
    const text = 'see https://github.com/org/repo/blob/0123456789abcdef/src/file.ts#L120'
    const line = 'see https://github.com/org/repo/blob/012345678\n9abcdef/src/file.ts#L120'
    expect(nativeChatLineShowsMessage(line, nativeChatExpectedLine(text))).toBe(true)
  })

  it('does not take an image chip as proof of the caption', () => {
    const expected = nativeChatExpectedLine('Reply with PONG')
    expect(nativeChatLineShowsMessage('[Image #1]', expected)).toBe(false)
    expect(nativeChatLineShowsMessage('[Image #1] Reply with PONG', expected)).toBe(true)
  })
})
