import { describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import type { PtyConnectResult, PtyTransport } from './pty-transport-types'
import { withRemoteReattachInputBuffer } from './remote-reattach-input-buffer'

const ORIGINAL_ID = 'remote:environment@@term_original'

function createHarness() {
  const connected = createDeferred<PtyConnectResult | undefined>()
  let ptyId: string | null = null
  const writes: string[] = []
  const delegate: PtyTransport = {
    connect: vi.fn(() => connected.promise),
    attach: vi.fn(),
    disconnect: vi.fn(),
    detach: vi.fn(),
    destroy: vi.fn(),
    isConnected: () => ptyId !== null,
    getPtyId: () => ptyId,
    resize: () => true,
    sendInput: vi.fn((data) => {
      if (!ptyId) {
        return false
      }
      writes.push(data)
      return true
    }),
    sendInputImmediate: vi.fn(() => false),
    sendInputAccepted: vi.fn(async (data) => {
      if (!ptyId) {
        return false
      }
      writes.push(data)
      return true
    })
  }
  return {
    delegate,
    connected,
    writes,
    transport: withRemoteReattachInputBuffer(delegate),
    finish(id: string | null = ORIGINAL_ID) {
      ptyId = id
      connected.resolve(id ? { id, isReattach: true } : undefined)
    }
  }
}

describe('remote reattach type-ahead', () => {
  it('preserves typing from the restored screen before connect starts', async () => {
    const harness = createHarness()
    expect(harness.transport.sendInput('before', 'driving')).toBe(true)
    const accepted = harness.transport.sendInputAccepted?.('\x03', 'driving')
    const connecting = harness.transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    expect(harness.transport.sendInput('after\r', 'driving')).toBe(true)
    harness.finish()
    await connecting
    await expect(accepted).resolves.toBe(true)
    expect(harness.writes).toEqual(['before', '\x03', 'after\r'])
  })

  it('discards pre-entry typing when the first connection creates a fresh terminal', async () => {
    const harness = createHarness()
    const accepted = harness.transport.sendInputAccepted?.('old tail\r', 'driving')
    const connecting = harness.transport.connect({ url: '', callbacks: {} })
    await expect(accepted).resolves.toBe(false)
    harness.finish('remote:environment@@fresh')
    await connecting
    expect(harness.writes).toEqual([])
  })

  it('delivers typing and an acknowledged interrupt once the original endpoint reattaches', async () => {
    const harness = createHarness()
    const connecting = harness.transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    expect(harness.transport.sendInput('partial', 'driving')).toBe(true)
    const accepted = harness.transport.sendInputAccepted?.('\x03', 'driving')
    expect(harness.transport.sendInput('next\r', 'driving')).toBe(true)
    expect(harness.writes).toEqual([])
    harness.finish()
    await connecting
    await expect(accepted).resolves.toBe(true)
    expect(harness.writes).toEqual(['partial', '\x03', 'next\r'])
    expect(harness.transport.sendInput('later', 'driving')).toBe(true)
    expect(harness.writes.at(-1)).toBe('later')
  })

  it.each(['remote:environment@@term_replacement', null])(
    'never forwards retained input when the original endpoint is unavailable: %s',
    async (replacementId) => {
      const harness = createHarness()
      const connecting = harness.transport.connect({
        url: '',
        sessionId: ORIGINAL_ID,
        callbacks: {}
      })
      const accepted = harness.transport.sendInputAccepted?.('dangerous tail\r', 'driving')
      harness.finish(replacementId)
      await connecting
      await expect(accepted).resolves.toBe(false)
      expect(harness.writes).toEqual([])
    }
  )

  it.each(['disconnect', 'detach', 'destroy'] as const)(
    'drops input and settles accepted writes on %s before a late reattach',
    async (action) => {
      const harness = createHarness()
      const connecting = harness.transport.connect({
        url: '',
        sessionId: ORIGINAL_ID,
        callbacks: {}
      })
      const accepted = harness.transport.sendInputAccepted?.('stale\r', 'driving')
      harness.transport[action]?.()
      await expect(accepted).resolves.toBe(false)
      harness.finish()
      await connecting
      expect(harness.writes).toEqual([])
    }
  )

  it('keeps newly typed bytes behind a pending acknowledged write', async () => {
    const harness = createHarness()
    const acknowledgement = createDeferred<boolean>()
    harness.delegate.sendInputAccepted = () => acknowledgement.promise
    const transport = withRemoteReattachInputBuffer(harness.delegate)
    const connecting = transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    const accepted = transport.sendInputAccepted?.('\x03', 'driving')
    harness.finish()
    await flushAsyncTicks()
    expect(transport.sendInput('after interrupt\r', 'driving')).toBe(true)
    expect(harness.writes).toEqual([])
    acknowledgement.resolve(true)
    await connecting
    await expect(accepted).resolves.toBe(true)
    expect(harness.writes).toEqual(['after interrupt\r'])
  })

  it('rejects pending writes when connection fails and leaves query replies unbuffered', async () => {
    const harness = createHarness()
    const connecting = harness.transport.connect({ url: '', sessionId: ORIGINAL_ID, callbacks: {} })
    const accepted = harness.transport.sendInputAccepted?.('typed', 'driving')
    expect(harness.transport.sendInput('\x1b[I', 'query-reply')).toBe(false)
    expect(harness.transport.sendInputImmediate('\x1b[1;1R')).toBe(false)
    harness.connected.reject(new Error('offline'))
    await expect(connecting).rejects.toThrow('offline')
    await expect(accepted).resolves.toBe(false)
    expect(harness.writes).toEqual([])
  })
})
