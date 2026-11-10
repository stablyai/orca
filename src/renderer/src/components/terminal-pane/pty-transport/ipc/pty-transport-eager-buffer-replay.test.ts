import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: { id: string; code: number; preserveRendererBinding?: boolean }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onExit = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('keeps exit sidecars after eager-buffered PTYs attach to a terminal', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { registerEagerPtyBuffer, subscribeToPtyExit } =
      await import('../delivery/pty-dispatcher')
    const eagerExit = vi.fn()
    const sidecarExit = vi.fn()

    registerEagerPtyBuffer('pty-restored', eagerExit)
    subscribeToPtyExit('pty-restored', sidecarExit)

    createIpcPtyTransport().attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })
    onExit?.({ id: 'pty-restored', code: 0 })

    expect(eagerExit).not.toHaveBeenCalled()
    expect(sidecarExit).toHaveBeenCalledWith(0, { hadPrimary: true })
  })

  it('drains pre-handler data and exit into eager buffers for fast background PTYs', async () => {
    const { ensurePtyDispatcher, registerEagerPtyBuffer } =
      await import('../delivery/pty-dispatcher')
    const onEagerExit = vi.fn()

    ensurePtyDispatcher()
    onData?.({ id: 'pty-fast-setup', data: 'setup failed fast\n' })
    onExit?.({ id: 'pty-fast-setup', code: 1 })

    const handle = registerEagerPtyBuffer('pty-fast-setup', onEagerExit)

    expect(handle.flush()).toBe('setup failed fast\n')
    await Promise.resolve()
    expect(onEagerExit).toHaveBeenCalledWith('pty-fast-setup', 1)
  })

  it('routes eager-buffered bytes through onReplayData so the renderer can engage the replay guard', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { registerEagerPtyBuffer } = await import('../delivery/pty-dispatcher')

    // Why: eager bytes carry DA1-style query sequences; onData bypasses the replay guard so xterm auto-replies, leaking input.
    const bufferedPayload = 'hello\x1b[cworld'

    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: bufferedPayload
    })

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    expect(handle.flush()).toBe('')
    expect(onReplayData).toHaveBeenCalledWith(bufferedPayload)
    expect(onDataCallback).not.toHaveBeenCalledWith(bufferedPayload)
  })

  it('does not let an unterminated OSC 9999 eager buffer swallow live output', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { registerEagerPtyBuffer } = await import('../delivery/pty-dispatcher')

    registerEagerPtyBuffer('pty-partial-status', vi.fn())
    onData?.({
      id: 'pty-partial-status',
      data: '\x1b]9999;{"state":"working"'
    })

    const transport = createIpcPtyTransport({ onAgentStatus: vi.fn() })
    const onReplayData = vi.fn()
    const onDataCallback = vi.fn()

    transport.attach({
      existingPtyId: 'pty-partial-status',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    expect(onReplayData.mock.calls).toEqual([['', { clearBeforeReplay: false }]])

    onData?.({
      id: 'pty-partial-status',
      data: 'live output'
    })

    expect(onDataCallback).toHaveBeenCalledWith('live output')
  })
})
