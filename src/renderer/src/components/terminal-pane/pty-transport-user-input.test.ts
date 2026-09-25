import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport: user input provenance', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('tags only the writes a person produced', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })

    transport.sendInput('typed', { userInput: true })
    await flushAsyncTicks()
    transport.sendInput('\x1b[I')
    await flushAsyncTicks()
    await transport.sendInputAccepted?.('\x03', { userInput: true })

    expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
      ['pty-1', 'typed', { userInput: true }],
      ['pty-1', '\x1b[I']
    ])
    expect(window.api.pty.writeAccepted).toHaveBeenCalledWith('pty-1', '\x03', { userInput: true })
    transport.disconnect()
  })

  it('never merges typed bytes with an untagged write', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })

    // The first write drains at once; what queues behind it would otherwise coalesce.
    transport.sendInput('\x1b[O')
    transport.sendInput('\x1b[I')
    transport.sendInput('a', { userInput: true })
    transport.sendInput('b', { userInput: true })

    await vi.waitFor(() =>
      expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
        ['pty-1', '\x1b[O'],
        ['pty-1', '\x1b[I'],
        ['pty-1', 'ab', { userInput: true }]
      ])
    )
    transport.disconnect()
  })

  it('keeps the tag on input typed before the spawn connects and across a remount handoff', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise as never)
    const { createIpcPtyTransport } = await import('./pty-transport')
    const captured: PtyPreconnectInputEntry[] = []
    const predecessor = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      onPreconnectInput: (entry) => captured.push(entry)
    })
    void predecessor.connect({ url: '', callbacks: {} })
    predecessor.sendInput('typed-early', { userInput: true })
    predecessor.sendInput('startup')
    predecessor.destroy?.()

    const successor = createIpcPtyTransport({ preconnectInput: captured })
    spawn.resolve({ id: 'pty-1' })
    await successor.connect({ url: '', callbacks: {} })
    await flushAsyncTicks()

    expect(captured).toEqual([
      { data: 'typed-early', kind: 'ordinary', userInput: true },
      { data: 'startup', kind: 'ordinary' }
    ])
    expect(vi.mocked(window.api.pty.write).mock.calls).toEqual([
      ['pty-1', 'typed-early', { userInput: true }],
      ['pty-1', 'startup']
    ])
  })
})
