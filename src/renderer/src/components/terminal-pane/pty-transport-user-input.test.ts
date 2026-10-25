import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport: input kind', () => {
  const originalWindow: typeof window | undefined = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('sends every write with the kind its writer gave it', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })

    transport.sendInput('typed', 'driving')
    await flushAsyncTicks()
    transport.sendInput('\x1b[I', 'query-reply')
    await flushAsyncTicks()
    transport.sendInputImmediate('\x1b[1;1R')
    await flushAsyncTicks()
    await transport.sendInputAccepted?.('echo startup\r', 'launch')

    expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
      ['pty-1', 'typed', 'driving'],
      ['pty-1', '\x1b[I', 'query-reply'],
      ['pty-1', '\x1b[1;1R', 'query-reply']
    ])
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', 'echo startup\r', 'launch')
    transport.disconnect()
  })

  it('never merges bytes of different kinds', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })

    // The first write drains at once; what queues behind it would otherwise coalesce.
    transport.sendInput('\x1b[O', 'query-reply')
    transport.sendInput('\x1b[I', 'query-reply')
    transport.sendInput('a', 'driving')
    transport.sendInput('b', 'driving')

    await vi.waitFor(() =>
      expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
        ['pty-1', '\x1b[O', 'query-reply'],
        ['pty-1', '\x1b[I', 'query-reply'],
        ['pty-1', 'ab', 'driving']
      ])
    )
    transport.disconnect()
  })

  it('keeps the kind of input written before the spawn connects and across a remount', async () => {
    const spawn = createDeferred<Awaited<ReturnType<typeof window.api.pty.spawn>>>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const captured: PtyPreconnectInputEntry[] = []
    const predecessor = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      onPreconnectInput: (entry) => captured.push(entry)
    })
    void predecessor.connect({ url: '', callbacks: {} })
    predecessor.sendInput('typed-early', 'driving')
    predecessor.sendInput('startup', 'launch')
    predecessor.destroy?.()

    const successor = createIpcPtyTransport({ preconnectInput: captured })
    spawn.resolve({ id: 'pty-1' })
    await successor.connect({ url: '', callbacks: {} })
    await flushAsyncTicks()

    expect(captured).toEqual([
      { data: 'typed-early', kind: 'ordinary', inputKind: 'driving' },
      { data: 'startup', kind: 'ordinary', inputKind: 'launch' }
    ])
    expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
      ['pty-1', 'typed-early', 'driving'],
      ['pty-1', 'startup', 'launch']
    ])
  })
})
