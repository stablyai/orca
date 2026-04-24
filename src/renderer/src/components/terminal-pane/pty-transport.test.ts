/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onExit: ((payload: { id: string; code: number }) => void) | null = null
  let onOpenCodeStatus:
    | ((payload: { ptyId: string; status: 'working' | 'idle' | 'permission' }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onExit = null
    onOpenCodeStatus = null

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          }),
          onOpenCodeStatus: vi.fn(
            (
              callback: (payload: {
                ptyId: string
                status: 'working' | 'idle' | 'permission'
              }) => void
            ) => {
              onOpenCodeStatus = callback
              return () => {}
            }
          )
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

  it('maps OpenCode status events into the existing working to idle agent lifecycle', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onAgentBecameWorking = vi.fn()
    const onAgentBecameIdle = vi.fn()

    const transport = createIpcPtyTransport({
      onTitleChange,
      onAgentBecameWorking,
      onAgentBecameIdle
    })

    await transport.connect({
      url: '',
      callbacks: {}
    })

    expect(onOpenCodeStatus).not.toBeNull()

    onOpenCodeStatus?.({ ptyId: 'pty-1', status: 'working' })
    onData?.({ id: 'pty-1', data: ']0;OpenCode' })
    onOpenCodeStatus?.({ ptyId: 'pty-1', status: 'idle' })

    expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)
    expect(onAgentBecameIdle).toHaveBeenCalledWith('OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(1, '⠋ OpenCode', '⠋ OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(2, '⠋ OpenCode', '⠋ OpenCode')
    expect(onTitleChange).toHaveBeenNthCalledWith(3, 'OpenCode', 'OpenCode')
    expect(onData).not.toBeNull()
    expect(onExit).not.toBeNull()
  })

  it('suppresses attention side effects when replaying eager-buffered data during attach', async () => {
    // Why: eager PTY buffers capture output produced before the pane mounted —
    // typically catch-up bytes from a previous app session. A BEL or
    // completion-style title arriving in that replay must NOT produce a fresh
    // alert. onTitleChange still fires so the tab label restores correctly,
    // but onBell and onAgentBecameIdle are gated by suppressAttentionEvents.
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentBecameIdle = vi.fn()

    const handle = registerEagerPtyBuffer('pty-restored', vi.fn())
    onData?.({
      id: 'pty-restored',
      data: ']0;. Claude working]0;* Claude done'
    })

    const transport = createIpcPtyTransport({
      onTitleChange,
      onBell,
      onAgentBecameIdle
    })

    transport.attach({
      existingPtyId: 'pty-restored',
      callbacks: {}
    })

    expect(handle.flush()).toBe('')
    expect(onTitleChange).toHaveBeenCalledWith('* Claude done', '* Claude done')
    expect(onBell).not.toHaveBeenCalled()
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
  })

  it('fires onBell for bare BELs but ignores BELs inside OSC sequences', async () => {
    // Why: Claude's OSC titles end with a BEL terminator (`\e]0;…\a`). The
    // stateful bell detector must know it is inside an OSC when that BEL
    // arrives and ignore it — otherwise every agent title change would
    // produce a spurious bell. A bare BEL outside an OSC is what actually
    // raises attention.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onBell = vi.fn()

    const transport = createIpcPtyTransport({ onBell })
    await transport.connect({ url: '', callbacks: {} })

    // OSC-terminating BELs: three titles, zero attention bells.
    onData?.({ id: 'pty-1', data: ']0;title-one' })
    onData?.({ id: 'pty-1', data: ']0;title-two' })
    onData?.({ id: 'pty-1', data: ']0;title-three' })
    expect(onBell).not.toHaveBeenCalled()

    // Bare BEL outside any OSC: fires once.
    onData?.({ id: 'pty-1', data: '' })
    expect(onBell).toHaveBeenCalledTimes(1)
  })

  it('routes eager-buffered bytes through onReplayData so the renderer can engage the replay guard', async () => {
    const { createIpcPtyTransport, registerEagerPtyBuffer } = await import('./pty-transport')

    // Why: eager-buffered bytes often contain query sequences (e.g. DA1 `\x1b[c`)
    // left over from a previous session. Routing them through onData instead of
    // onReplayData would bypass pty-connection's replay guard and xterm would
    // auto-reply to those queries, leaking stray input into the shell.
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

  it('routes the attach-time clear sequence through onReplayData for non-alternate-screen sessions', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-attached',
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    // Why: the clear preamble must travel the replay path so any subsequent
    // snapshot bytes sit under the same replay guard in pty-connection.ts.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData).toHaveBeenCalledWith(clear)
    expect(onDataCallback).not.toHaveBeenCalledWith(clear)
  })

  it('skips the attach-time clear sequence for alternate-screen sessions', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')

    const transport = createIpcPtyTransport()
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()

    transport.attach({
      existingPtyId: 'pty-alt-screen',
      isAlternateScreen: true,
      callbacks: {
        onData: onDataCallback,
        onReplayData
      }
    })

    // Why: alternate-screen snapshots already fill the viewport; emitting the
    // clear would erase the restored content. Neither path should see it.
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    expect(onReplayData).not.toHaveBeenCalledWith(clear)
    expect(onDataCallback).not.toHaveBeenCalledWith(clear)
  })

  it('passes startup commands through PTY spawn instead of writing them after connect', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({ id: 'pty-1' })
    const writeMock = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: writeMock,
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          }),
          onOpenCodeStatus: vi.fn(
            (
              callback: (payload: {
                ptyId: string
                status: 'working' | 'idle' | 'permission'
              }) => void
            ) => {
              onOpenCodeStatus = callback
              return () => {}
            }
          )
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })

    await transport.connect({
      url: '',
      cols: 120,
      rows: 40,
      callbacks: {}
    })

    expect(spawnMock).toHaveBeenCalledWith({
      cols: 120,
      rows: 40,
      cwd: '/tmp/worktree',
      env: { FOO: 'bar' },
      command: 'echo hello'
    })
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('preserves snapshot dimensions when reattaching', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({
      id: 'pty-reattach',
      isReattach: true,
      snapshot: 'snapshot data',
      snapshotCols: 132,
      snapshotRows: 43
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          }),
          onOpenCodeStatus: vi.fn(
            (
              callback: (payload: {
                ptyId: string
                status: 'working' | 'idle' | 'permission'
              }) => void
            ) => {
              onOpenCodeStatus = callback
              return () => {}
            }
          )
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const result = await transport.connect({
      url: '',
      sessionId: 'pty-reattach',
      callbacks: {}
    })

    expect(result).toEqual({
      id: 'pty-reattach',
      snapshot: 'snapshot data',
      isAlternateScreen: undefined,
      coldRestore: undefined
    })
  })

  it('kills a PTY that finishes spawning after the transport was destroyed', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnControls: { resolve: ((value: { id: string }) => void) | null } = { resolve: null }
    const spawnPromise = new Promise<{ id: string }>((resolve) => {
      spawnControls.resolve = resolve
    })
    const spawnMock = vi.fn().mockReturnValue(spawnPromise)
    const killMock = vi.fn()
    const onPtySpawn = vi.fn()

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          spawn: spawnMock,
          write: vi.fn(),
          resize: vi.fn(),
          kill: killMock,
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            onData = callback
            return () => {}
          }),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          }),
          onOpenCodeStatus: vi.fn(
            (
              callback: (payload: {
                ptyId: string
                status: 'working' | 'idle' | 'permission'
              }) => void
            ) => {
              onOpenCodeStatus = callback
              return () => {}
            }
          )
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({ onPtySpawn })
    const connectPromise = transport.connect({
      url: '',
      callbacks: {}
    })

    transport.destroy?.()
    if (!spawnControls.resolve) {
      throw new Error('Expected spawn resolver to be captured')
    }
    spawnControls.resolve({ id: 'pty-late' })
    await connectPromise

    expect(killMock).toHaveBeenCalledWith('pty-late')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
  })

  it('unregisterPtyDataHandlers prevents final data burst from triggering notifications', async () => {
    const { createIpcPtyTransport, unregisterPtyDataHandlers } = await import('./pty-transport')
    const onTitleChange = vi.fn()
    const onBell = vi.fn()
    const onAgentBecameIdle = vi.fn()
    const onAgentBecameWorking = vi.fn()
    const onPtyExit = vi.fn()

    const transport = createIpcPtyTransport({
      onTitleChange,
      onBell,
      onAgentBecameIdle,
      onAgentBecameWorking,
      onPtyExit
    })

    await transport.connect({ url: '', callbacks: {} })

    // Agent starts working
    onData?.({ id: 'pty-1', data: ']0;. Claude working' })
    expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

    // Simulate shutdownWorktreeTerminals: unregister data handlers before kill.
    unregisterPtyDataHandlers(['pty-1'])

    // Final data burst from main process (flushed before exit) — contains a
    // title change and a BEL. Neither should produce a notification because
    // the data handler was removed.
    onData?.({ id: 'pty-1', data: ']0;Claude done' })
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()

    // Exit handler should still work (exit handlers are kept alive)
    onExit?.({ id: 'pty-1', code: -1 })
    expect(onPtyExit).toHaveBeenCalledWith('pty-1')
  })

  it('unregisterPtyDataHandlers cancels staleTitleTimer so it cannot fire stale idle transition', async () => {
    vi.useFakeTimers()
    try {
      const { createIpcPtyTransport, unregisterPtyDataHandlers } = await import('./pty-transport')
      const onTitleChange = vi.fn()
      const onAgentBecameIdle = vi.fn()
      const onAgentBecameWorking = vi.fn()

      const transport = createIpcPtyTransport({
        onTitleChange,
        onAgentBecameIdle,
        onAgentBecameWorking
      })

      await transport.connect({ url: '', callbacks: {} })

      // Agent starts working — sets the title to a working indicator
      onData?.({ id: 'pty-1', data: ']0;. Claude working' })
      expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

      // Data arrives without a title change — starts the 3 s staleTitleTimer
      onData?.({ id: 'pty-1', data: 'some output without title\r\n' })

      // Simulate shutdownWorktreeTerminals: unregister handlers which should
      // cancel the pending staleTitleTimer AND reset the agent tracker so the
      // accumulated working state cannot produce a stale idle transition.
      unregisterPtyDataHandlers(['pty-1'])

      // Advance past the 3 s stale-title timeout
      vi.advanceTimersByTime(4000)

      // The staleTitleTimer must NOT have fired onAgentBecameIdle
      expect(onAgentBecameIdle).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the exit observer alive after detach so remounts do not reuse dead PTYs', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onPtyExit = vi.fn()
    const onTitleChange = vi.fn()

    const transport = createIpcPtyTransport({
      onPtyExit,
      onTitleChange
    })

    transport.attach({
      existingPtyId: 'pty-detached',
      callbacks: {
        onData: vi.fn(),
        onDisconnect: vi.fn()
      }
    })

    transport.detach?.()

    onData?.({ id: 'pty-detached', data: ']0;Detached title' })
    expect(onTitleChange).not.toHaveBeenCalled()

    onExit?.({ id: 'pty-detached', code: 0 })

    expect(onPtyExit).toHaveBeenCalledWith('pty-detached')
    expect(transport.getPtyId()).toBeNull()
  })
})
