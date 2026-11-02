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
  it('observes driving attempts synchronously before rejection/ACK without recounting seeds or flush', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { PTY_PRECONNECT_INPUT_MAX_CODE_UNITS } = await import('./pty-preconnect-input-buffer')
    const retained = vi.fn()
    const observed = vi.fn(() => expect(retained).not.toHaveBeenCalled())
    const transport = createIpcPtyTransport({
      bufferInputUntilConnect: true,
      preconnectInput: [{ data: 'seed', kind: 'ordinary', inputKind: 'driving' }],
      onPreconnectInput: retained,
      onDrivingInputAttempt: observed
    })
    expect(observed).not.toHaveBeenCalled()
    expect(
      transport.sendInput('x'.repeat(PTY_PRECONNECT_INPUT_MAX_CODE_UNITS + 1), 'driving')
    ).toBe(false)
    expect(observed).toHaveBeenCalledWith(null)
    expect(retained).not.toHaveBeenCalled()
    const accepted = transport.sendInputAccepted?.('typed', 'driving')
    expect(observed).toHaveBeenCalledTimes(2)
    transport.sendInputImmediate('reply')
    transport.sendInput('launch', 'launch')
    transport.sendInput('reply', 'query-reply')
    await transport.connect({ url: '', callbacks: {} })
    expect(await accepted).toBe(true)
    expect(observed).toHaveBeenCalledTimes(2)
    observed.mockImplementation(() => {})
    const ack = createDeferred<boolean>()
    vi.mocked(window.api.pty.writeAccepted).mockReturnValue(ack.promise)
    const liveAccepted = transport.sendInputAccepted?.('live', 'driving')
    expect(observed).toHaveBeenLastCalledWith('pty-1')
    ack.resolve(true)
    expect(await liveAccepted).toBe(true)
    transport.destroy?.()
    transport.sendInput('after disposal', 'driving')
    expect(observed).toHaveBeenCalledTimes(3)
  })
})
