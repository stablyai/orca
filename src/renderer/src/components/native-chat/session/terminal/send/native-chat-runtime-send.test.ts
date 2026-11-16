import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writes } = vi.hoisted(() => ({ writes: [] as string[] }))

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
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'

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
  it('presses Enter once the input line shows the pasted message', async () => {
    let line = ''
    sendNativeChatMessage('pty-1', 'Reply with PONG', {
      clearInput: '',
      readInputLine: () => line,
      onWriteRejected: () => {}
    })
    await vi.advanceTimersByTimeAsync(1500)
    expect(writes).toEqual(['Reply with PONG'])

    line = 'Reply with PONG'
    await vi.advanceTimersByTimeAsync(150)
    expect(writes).toEqual(['Reply with PONG', '\r'])
  })
})
