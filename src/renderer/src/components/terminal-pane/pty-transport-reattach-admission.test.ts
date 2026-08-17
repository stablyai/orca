import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushPtySideEffects,
  installIpcPtyWindow,
  restorePtySpecWindow
} from './pty-transport-test-harness'

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

  it('retires an adopted PTY when recovery disconnects before a replacement spawn', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({ id: 'empty-reattach', isReattach: true })
    const transport = createIpcPtyTransport({})

    await transport.connect({ url: '', sessionId: 'empty-reattach', callbacks: {} })
    transport.disconnect()

    expect(kill).toHaveBeenCalledWith('empty-reattach')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('announces a daemon adoption before publishing its buffered PTY data', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({ id: 'adopted-pty', isReattach: true })
    const order: string[] = []
    const transport = createIpcPtyTransport({})
    const connecting = transport.connect({
      url: '',
      callbacks: {
        onReattachDetermined: () => order.push('adopt'),
        onData: () => order.push('data')
      }
    })
    onData?.({ id: 'adopted-pty', data: 'buffered' })
    await connecting

    expect(order).toEqual(['adopt', 'data'])
  })

  it('does not reannounce an explicit reattach already owned by its caller', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({ id: 'restored-pty', isReattach: true })
    const onReattachDetermined = vi.fn()
    const transport = createIpcPtyTransport({})

    await transport.connect({
      url: '',
      sessionId: 'restored-pty',
      callbacks: { onReattachDetermined }
    })

    expect(onReattachDetermined).not.toHaveBeenCalled()
  })

  it('leaves the transport silently unbound after a failed connect — sendInput drops with no write IPC (frozen-terminal repro)', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const write = window.api.pty.write as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({})

    // Generic spawn failure: onError fires, but the transport stays unbound and later keystrokes drop with no further signal.
    spawn.mockRejectedValueOnce(new Error('daemon socket not ready'))
    const onError = vi.fn()
    await transport.connect({ url: '', callbacks: { onError } })
    expect(onError).toHaveBeenCalled()
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('echo hello\r')).toBe(false)
    await flushPtySideEffects()
    expect(write).not.toHaveBeenCalled()

    // Tombstoned-session rejection has no callback at all, so a restored pane silently eats keystrokes while showing content (#2836).
    spawn.mockRejectedValueOnce(new Error('TerminalKilledError: session xyz was explicitly killed'))
    const onErrorKilled = vi.fn()
    await transport.connect({ url: '', callbacks: { onError: onErrorKilled } })
    expect(onErrorKilled).not.toHaveBeenCalled()
    expect(transport.isConnected()).toBe(false)
    expect(transport.sendInput('echo hello\r')).toBe(false)
    await flushPtySideEffects()
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects a stale reattach before it can replace newer PTY handlers', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    let resolveStale!: (value: { id: string; isReattach: boolean }) => void
    spawn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve
      })
    )
    const staleData = vi.fn()
    const staleExit = vi.fn()
    const stalePane = createIpcPtyTransport({})
    const staleConnect = stalePane.connect({
      url: '',
      sessionId: 'pty-1',
      admitPtyId: () => false,
      callbacks: { onData: staleData, onExit: staleExit }
    })
    const currentData = vi.fn()
    const currentExit = vi.fn()
    const currentPane = createIpcPtyTransport({})
    currentPane.attach({
      existingPtyId: 'pty-1',
      callbacks: { onData: currentData, onExit: currentExit }
    })

    resolveStale({ id: 'pty-1', isReattach: true })
    await staleConnect
    onData?.({ id: 'pty-1', data: 'current output' })
    onExit?.({ id: 'pty-1', code: 0 })

    expect(currentData).toHaveBeenCalledWith('current output')
    expect(currentExit).toHaveBeenCalledWith(0)
    expect(staleData).not.toHaveBeenCalled()
    expect(staleExit).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it('retires a rejected fresh fallback before it can publish PTY handlers', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    const onPtySpawn = vi.fn()
    const onDataCallback = vi.fn()
    const onExitCallback = vi.fn()
    spawn.mockResolvedValueOnce({ id: 'pty-fresh-fallback', sessionExpired: true })
    const transport = createIpcPtyTransport({ onPtySpawn })

    const result = await transport.connect({
      url: '',
      sessionId: 'pty-missing',
      admitPtyId: () => false,
      callbacks: { onData: onDataCallback, onExit: onExitCallback }
    })
    onData?.({ id: 'pty-fresh-fallback', data: 'orphaned output' })
    onExit?.({ id: 'pty-fresh-fallback', code: 0 })

    expect(result).toEqual({ id: 'pty-fresh-fallback', sessionExpired: true })
    expect(kill).toHaveBeenCalledExactlyOnceWith('pty-fresh-fallback')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onExitCallback).not.toHaveBeenCalled()
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('surfaces rejected fresh fallback retirement without publishing PTY handlers', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    const onPtySpawn = vi.fn()
    const onDataCallback = vi.fn()
    const onExitCallback = vi.fn()
    const onErrorCallback = vi.fn()
    const retirementError = new Error('provider shutdown refused')
    spawn.mockResolvedValueOnce({ id: 'pty-fresh-fallback', sessionExpired: true })
    kill.mockRejectedValueOnce(retirementError)
    const transport = createIpcPtyTransport({ onPtySpawn })

    await expect(
      transport.connect({
        url: '',
        sessionId: 'pty-missing',
        admitPtyId: () => false,
        callbacks: {
          onData: onDataCallback,
          onExit: onExitCallback,
          onError: onErrorCallback
        }
      })
    ).resolves.toBeUndefined()
    onData?.({ id: 'pty-fresh-fallback', data: 'orphaned output' })
    onExit?.({ id: 'pty-fresh-fallback', code: 0 })

    expect(kill).toHaveBeenCalledExactlyOnceWith('pty-fresh-fallback')
    expect(onPtySpawn).not.toHaveBeenCalled()
    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onExitCallback).not.toHaveBeenCalled()
    expect(onErrorCallback).toHaveBeenCalledExactlyOnceWith(retirementError.message)
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('mints a fresh id instead of reopening a discarded same-id session', async () => {
    const { discardPreHandlerPtyState, clearPreHandlerPtyState } =
      await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const discardedId = 'removed-worktree@@discarded-session'
    discardPreHandlerPtyState(discardedId)

    await createIpcPtyTransport({ cwdFallback: 'worktree' }).connect({
      url: '',
      sessionId: discardedId,
      callbacks: {}
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwdFallback: 'worktree' }))
    expect(spawn).toHaveBeenCalledWith(expect.not.objectContaining({ sessionId: discardedId }))
    clearPreHandlerPtyState(discardedId)
  })

  it('delivers a buffered dead-session exit without respawning the same session id', async () => {
    const { bufferPreHandlerPtyData, bufferPreHandlerPtyExit } =
      await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onDataCallback = vi.fn()
    const onExitCallback = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const sessionId = 'dead-parked-session'
    bufferPreHandlerPtyData(sessionId, 'final output')
    bufferPreHandlerPtyExit(sessionId, 17)

    const transport = createIpcPtyTransport({ onPtyExit })
    const result = await transport.connect({
      url: '',
      sessionId,
      callbacks: { onData: onDataCallback, onExit: onExitCallback, onDisconnect }
    })

    expect(result).toEqual({ id: sessionId, exitedBeforeAttach: true })
    expect(spawn).not.toHaveBeenCalled()
    expect(onDataCallback).toHaveBeenCalledWith('final output')
    expect(onExitCallback).toHaveBeenCalledWith(17)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onPtyExit).toHaveBeenCalledWith(sessionId)
    expect(transport.isConnected()).toBe(false)
  })

  it('rejects a buffered dead-session exit before publishing its final frame', async () => {
    const { bufferPreHandlerPtyData, bufferPreHandlerPtyExit, clearPreHandlerPtyState } =
      await import('./pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onDataCallback = vi.fn()
    const onExitCallback = vi.fn()
    const onDisconnect = vi.fn()
    const onPtyExit = vi.fn()
    const sessionId = 'stale-dead-parked-session'
    bufferPreHandlerPtyData(sessionId, 'stale final output')
    bufferPreHandlerPtyExit(sessionId, 17)

    const transport = createIpcPtyTransport({ onPtyExit })
    const result = await transport.connect({
      url: '',
      sessionId,
      admitPtyId: () => false,
      callbacks: { onData: onDataCallback, onExit: onExitCallback, onDisconnect }
    })

    expect(result).toEqual({ id: sessionId })
    expect(spawn).not.toHaveBeenCalled()
    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onExitCallback).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
    expect(transport.isConnected()).toBe(false)
    clearPreHandlerPtyState(sessionId)
  })

  it('preserves snapshot dimensions and split alt-frame strings when reattaching', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({
      id: 'pty-reattach',
      isReattach: true,
      launchAgent: 'droid',
      snapshot: 'snapshot data',
      snapshotCols: 132,
      snapshotRows: 43,
      snapshotPrefixAnsi: 'history and modes',
      snapshotFrameAnsi: 'visual frame',
      snapshotFrameRestoreAnsi: 'live state'
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
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
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
      isReattach: true,
      launchAgent: 'droid',
      snapshot: 'snapshot data',
      snapshotCols: 132,
      snapshotRows: 43,
      snapshotPrefixAnsi: 'history and modes',
      snapshotFrameAnsi: 'visual frame',
      snapshotFrameRestoreAnsi: 'live state',
      isAlternateScreen: undefined,
      coldRestore: undefined,
      replay: undefined,
      sessionExpired: undefined
    })
  })

  it('drops an unknown daemon launch identity from the connection result', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    spawn.mockResolvedValueOnce({
      id: 'pty-unknown-launch-agent',
      isReattach: true,
      launchAgent: 'not-an-agent'
    })

    const result = await createIpcPtyTransport({}).connect({ url: '', callbacks: {} })

    expect(result).toEqual({
      id: 'pty-unknown-launch-agent',
      isReattach: true,
      snapshot: undefined,
      snapshotCols: undefined,
      snapshotRows: undefined,
      isAlternateScreen: undefined,
      sessionExpired: undefined,
      coldRestore: undefined,
      replay: undefined,
      pendingEscapeTailAnsi: undefined
    })
  })

  it('threads the daemon pendingEscapeTailAnsi through the reattach connect result (#7329)', async () => {
    // Why: dropping the daemon's mid-escape tail from the reattach result silently regressed the local half of #7329.
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnMock = vi.fn().mockResolvedValue({
      id: 'pty-reattach-tail',
      isReattach: true,
      snapshot: 'snapshot data',
      snapshotCols: 80,
      snapshotRows: 24,
      pendingEscapeTailAnsi: '\x1b[3'
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
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport()
    const result = await transport.connect({
      url: '',
      sessionId: 'pty-reattach-tail',
      callbacks: {}
    })

    expect(result).toMatchObject({
      id: 'pty-reattach-tail',
      pendingEscapeTailAnsi: '\x1b[3'
    })
  })

  it('does not kill a pre-existing session when a reattach resolves after destroy', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnControls: {
      resolve: ((value: { id: string; isReattach: true }) => void) | null
    } = { resolve: null }
    const spawnPromise = new Promise<{ id: string; isReattach: true }>((resolve) => {
      spawnControls.resolve = resolve
    })
    const spawnMock = vi.fn().mockReturnValue(spawnPromise)
    const killMock = vi.fn()

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
          onData: vi.fn(() => () => {}),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {})
        }
      }
    } as unknown as typeof window

    const transport = createIpcPtyTransport({})
    const connectPromise = transport.connect({
      url: '',
      callbacks: {},
      // A reattach targets a pre-existing session, so destroying the view must not reap the user's live shell.
      sessionId: 'pty-preexisting'
    })

    transport.destroy?.()
    if (!spawnControls.resolve) {
      throw new Error('Expected spawn resolver to be captured')
    }
    spawnControls.resolve({ id: 'pty-preexisting', isReattach: true })
    await connectPromise

    expect(killMock).not.toHaveBeenCalledWith('pty-preexisting')
  })

  it('kills a fresh session fallback that resolves after the transport was destroyed', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawnControls: {
      resolve: ((value: { id: string; sessionExpired: true }) => void) | null
    } = { resolve: null }
    const spawnPromise = new Promise<{ id: string; sessionExpired: true }>((resolve) => {
      spawnControls.resolve = resolve
    })
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    spawn.mockReturnValueOnce(spawnPromise)
    const transport = createIpcPtyTransport({})
    const connectPromise = transport.connect({
      url: '',
      sessionId: 'pty-missing',
      callbacks: {}
    })

    transport.destroy?.()
    if (!spawnControls.resolve) {
      throw new Error('Expected spawn resolver to be captured')
    }
    spawnControls.resolve({ id: 'pty-fresh-fallback', sessionExpired: true })
    await connectPromise

    expect(kill).toHaveBeenCalledExactlyOnceWith('pty-fresh-fallback')
    expect(transport.getPtyId()).toBeNull()
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
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
            onExit = callback
            return () => {}
          })
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
})
