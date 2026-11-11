import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('dispatcher delivery before attachment and during exit', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  // The singleton dispatcher subscribes one global onData callback; we capture it to simulate main delivering IPC events directly.
  let dispatcherCallback:
    | ((payload: { id: string; data: string; rawLength?: number; background?: boolean }) => void)
    | null = null
  let exitDispatcherCallback: ((payload: { id: string; code: number }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    dispatcherCallback = null
    exitDispatcherCallback = null
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-pi' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          ackData: vi.fn(),
          rendererDispatcherReady: vi.fn(),
          onData: vi.fn(
            (
              cb: (payload: {
                id: string
                data: string
                rawLength?: number
                background?: boolean
              }) => void
            ) => {
              // Only the first subscriber wins in production (ensurePtyDispatcher's ptyDispatcherAttached guard), so capture the first callback and ignore the rest.
              if (!dispatcherCallback) {
                dispatcherCallback = cb
              }
              return () => {}
            }
          ),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((cb: (payload: { id: string; code: number }) => void) => {
            if (!exitDispatcherCallback) {
              exitDispatcherCallback = cb
            }
            return () => {}
          })
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('replays PTY data that arrives before connect() registers the pane handler', async () => {
    const { createIpcPtyTransport } = await import('../ipc/pty-transport')
    const onData = vi.fn()
    let resolveSpawn: (value: { id: string }) => void = () => {}

    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )

    const transport = createIpcPtyTransport()
    const connectPromise = transport.connect({ url: '', callbacks: { onData } })

    dispatcherCallback?.({ id: 'pty-early', data: 'setup starts here\r\n', rawLength: 19 })
    expect(onData).not.toHaveBeenCalled()
    expect(window.api.pty.ackData).toHaveBeenCalledWith('pty-early', 19, 19)

    resolveSpawn({ id: 'pty-early' })
    await connectPromise

    expect(onData).toHaveBeenCalledWith('setup starts here\r\n', { rawLength: 19 })

    transport.disconnect()
  })

  it('preserves buffered live-session data when reconnect re-admits a consumed id', async () => {
    const { consumePreHandlerPtyState } = await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('../ipc/pty-transport')
    const { ensurePtyDispatcher } = await import('./pty-dispatcher')
    const onData = vi.fn()

    ensurePtyDispatcher()
    consumePreHandlerPtyState('pty-persisted')
    dispatcherCallback?.({ id: 'pty-persisted', data: 'live before pane\r\n', rawLength: 18 })
    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'pty-persisted',
      isReattach: true
    })

    const transport = createIpcPtyTransport()
    await transport.connect({
      url: '',
      sessionId: 'pty-persisted',
      callbacks: { onData }
    })

    expect(onData).toHaveBeenCalledWith('live before pane\r\n', { rawLength: 18 })
    transport.disconnect()
  })

  it('replays pre-handler PTY data before a pre-handler exit', async () => {
    const { createIpcPtyTransport } = await import('../ipc/pty-transport')
    const events: string[] = []
    let resolveSpawn: (value: { id: string }) => void = () => {}

    ;(window.api.pty.spawn as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )

    const cleanupError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const transport = createIpcPtyTransport({
      onPtyExit: () => {
        throw new Error('pre-attach cleanup failed')
      }
    })
    const connectPromise = transport.connect({
      url: '',
      callbacks: {
        onData: (data) => events.push(`data:${data}`),
        onExit: (code) => events.push(`exit:${code}`)
      }
    })

    dispatcherCallback?.({ id: 'pty-fast-exit', data: 'last line\r\n', rawLength: 11 })
    exitDispatcherCallback?.({ id: 'pty-fast-exit', code: 3 })
    resolveSpawn({ id: 'pty-fast-exit' })
    const connectResult = await connectPromise

    expect(events).toEqual(['data:last line\r\n', 'exit:3'])
    expect(connectResult).toEqual({ id: 'pty-fast-exit', exitedBeforeAttach: true })
    expect(cleanupError).toHaveBeenCalled()

    exitDispatcherCallback?.({ id: 'pty-fast-exit', code: 4 })
    const duplicateExit = vi.fn()
    const { drainPreHandlerPtyExit } = await import('./pty-pre-handler-buffer')
    drainPreHandlerPtyExit('pty-fast-exit', duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })

  it('finalizes a throwing primary exit and still delivers every sidecar', async () => {
    const { ensurePtyDispatcher, subscribeToPtyExit } = await import('./pty-dispatcher')
    const { ptyExitHandlers } = await import('../shutdown/pty-shutdown-data-suspension')
    const primary = vi.fn(() => {
      throw new Error('primary exit failed')
    })
    const firstSidecar = vi.fn(() => {
      throw new Error('sidecar exit failed')
    })
    const secondSidecar = vi.fn()

    ensurePtyDispatcher()
    ptyExitHandlers.set('pty-throwing-exit', primary)
    subscribeToPtyExit('pty-throwing-exit', firstSidecar)
    subscribeToPtyExit('pty-throwing-exit', secondSidecar)

    expect(() => exitDispatcherCallback?.({ id: 'pty-throwing-exit', code: 9 })).toThrow(
      'primary exit failed'
    )
    expect(firstSidecar).toHaveBeenCalledWith(9, { hadPrimary: true })
    expect(secondSidecar).toHaveBeenCalledWith(9, { hadPrimary: true })

    expect(() => exitDispatcherCallback?.({ id: 'pty-throwing-exit', code: 10 })).not.toThrow()
    expect(primary).toHaveBeenCalledTimes(1)
    const duplicateExit = vi.fn()
    const { drainPreHandlerPtyExit } = await import('./pty-pre-handler-buffer')
    drainPreHandlerPtyExit('pty-throwing-exit', duplicateExit)
    expect(duplicateExit).not.toHaveBeenCalled()
  })
})
