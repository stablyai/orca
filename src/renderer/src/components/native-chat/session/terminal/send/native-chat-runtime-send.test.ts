import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writes, preparation } = vi.hoisted(() => {
  const writes: string[] = []
  const preparation: {
    hold: boolean
    deliver?: () => void
    holdEnter?: boolean
    acknowledgeEnter?: () => void
  } = { hold: false }
  return { writes, preparation }
})

vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: (_ptyId: string, data: string) => {
    writes.push(data)
    return true
  }
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-verified-input', () => ({
  sendRuntimePtyInputVerified: (_ptyId: string, data: string) => {
    writes.push(data)
    if (data === '\r' && preparation.holdEnter) {
      return new Promise<boolean>((resolve) => {
        preparation.acknowledgeEnter = () => resolve(true)
      })
    }
    return Promise.resolve(true)
  }
}))

vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: async (
    _target: unknown,
    _method: string,
    _params: unknown,
    handlers: { onEvent: (value: unknown) => void }
  ) => {
    preparation.deliver = () => handlers.onEvent({ paths: ['/views/hero.png'] })
    if (!preparation.hold) {
      preparation.deliver()
    }
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/store/index', () => ({ useAppStore: { subscribe: () => () => {} } }))
vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => ({
    target: { kind: 'environment', environmentId: 'outer-server' },
    terminal: 'terminal-1'
  })
}))

import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { sendNativeChatMessage, sendNativeChatTypedCommand } from './native-chat-runtime-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'
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

  it('does not submit a partially typed command after cancellation', async () => {
    const handle = sendNativeChatTypedCommand('pty-command', '/model opus')
    await vi.advanceTimersByTimeAsync(0)
    handle.cancel()
    await vi.advanceTimersByTimeAsync(2000)
    expect(writes).not.toContain('\r')
    await expect(handle.outcome).resolves.toBe('uncertain')
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
})

describe('fitted image delivery', () => {
  it.each([false, true])(
    'preserves existing input when preparation is cancelled (observed=%s)',
    async (observed) => {
      vi.useFakeTimers()
      writes.length = 0
      preparation.hold = true
      try {
        const handle = sendNativeChatMessageWithImageAttachments(
          'claude',
          'pty-image',
          'Inspect this image',
          ['/repo/hero.png'],
          {
            readInputLine: () => 'Keep my existing draft',
            ...(observed ? { onWriteRejected: () => {} } : {})
          }
        )
        await vi.advanceTimersByTimeAsync(0)
        handle.cancel()
        await vi.advanceTimersByTimeAsync(2000)
        expect(writes).toEqual([])
        await expect(handle.outcome).resolves.toBe('not-submitted')
      } finally {
        preparation.hold = false
        resetNativeChatPtySendQueuesForTests()
        vi.useRealTimers()
      }
    }
  )

  it.each([false, true])(
    'does not write an image or Enter after its intended agent leaves (observed=%s)',
    async (observed) => {
      vi.useFakeTimers()
      writes.length = 0
      preparation.hold = true
      let current = true
      try {
        const handle = sendNativeChatMessageWithImageAttachments(
          'claude',
          'pty-agent',
          'Inspect this',
          ['/repo/hero.png'],
          {
            clearInput: '',
            isCurrent: () => current,
            ...(observed ? { onWriteRejected: () => {} } : {})
          }
        )
        await vi.advanceTimersByTimeAsync(0)
        current = false
        preparation.deliver?.()
        await vi.advanceTimersByTimeAsync(2000)
        expect(writes).toEqual([])
        await expect(handle.outcome).resolves.toBe('not-submitted')
      } finally {
        preparation.hold = false
        resetNativeChatPtySendQueuesForTests()
        vi.useRealTimers()
      }
    }
  )

  it.each([false, true])(
    'does not submit or clear successor input after writing an image (observed=%s)',
    async (observed) => {
      vi.useFakeTimers()
      writes.length = 0
      let current = true
      try {
        const handle = sendNativeChatMessageWithImageAttachments(
          'claude',
          'pty-agent',
          'Inspect this',
          ['/repo/hero.png'],
          {
            clearInput: '',
            isCurrent: () => current,
            ...(observed ? { onWriteRejected: () => {} } : {})
          }
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(writes.some((text) => text.includes('/views/hero.png'))).toBe(true)
        const written = [...writes]
        current = false
        await vi.advanceTimersByTimeAsync(2000)
        expect(writes).toEqual(written)
        expect(writes).not.toContain('\r')
        await expect(handle.outcome).resolves.toBe('uncertain')
      } finally {
        resetNativeChatPtySendQueuesForTests()
        vi.useRealTimers()
      }
    }
  )

  it('keeps a proven Enter acknowledgment submitted when the agent exits immediately afterward', async () => {
    vi.useFakeTimers()
    writes.length = 0
    preparation.holdEnter = true
    let current = true
    try {
      const handle = sendNativeChatMessageWithImageAttachments(
        'claude',
        'pty-agent',
        'Inspect this',
        ['/repo/hero.png'],
        { clearInput: '', isCurrent: () => current, onWriteRejected: () => {} }
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes).toContain('\r')
      const sent = [...writes]
      current = false
      preparation.acknowledgeEnter?.()
      await vi.advanceTimersByTimeAsync(0)
      await expect(handle.outcome).resolves.toBe('submitted')
      expect(writes).toEqual(sent)
    } finally {
      preparation.holdEnter = false
      resetNativeChatPtySendQueuesForTests()
      vi.useRealTimers()
    }
  })

  it.each([false, true])(
    'keeps a nested SSH attachment on its own host (observed=%s)',
    async (observed) => {
      vi.useFakeTimers()
      writes.length = 0
      try {
        const handle = sendNativeChatMessageWithImageAttachments(
          'claude',
          'remote:outer-server@@terminal-1',
          'Inspect this image',
          ['/repo/.orca/drops/hero.png'],
          {
            executionHostId: 'ssh:inner-server',
            clearInput: '',
            ...(observed ? { onWriteRejected: () => {} } : {})
          }
        )
        await vi.advanceTimersByTimeAsync(2000)
        expect(writes.some((text) => text.includes('/repo/.orca/drops/hero.png'))).toBe(true)
        expect(writes.some((text) => text.includes('/views/hero.png'))).toBe(false)
        await expect(handle.outcome).resolves.toBe('submitted')
      } finally {
        resetNativeChatPtySendQueuesForTests()
        vi.useRealTimers()
      }
    }
  )

  it('sends the viewing image and retains the selected editing target', async () => {
    vi.useFakeTimers()
    writes.length = 0
    try {
      const handle = sendNativeChatMessageWithImageAttachments(
        'codex',
        'pty-image',
        'Edit the attached image in place',
        ['/repo/hero.png']
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(writes.some((text) => text.includes('/views/hero.png'))).toBe(true)
      expect(
        writes.some(
          (text) =>
            text.includes('/repo/hero.png') && text.includes('Edit the attached image in place')
        )
      ).toBe(true)
      await expect(handle.outcome).resolves.toBe('submitted')
    } finally {
      resetNativeChatPtySendQueuesForTests()
      vi.useRealTimers()
    }
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
