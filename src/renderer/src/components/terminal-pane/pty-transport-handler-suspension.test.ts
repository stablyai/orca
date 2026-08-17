import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushPtySideEffects,
  installIpcPtyWindow,
  restorePtySpecWindow
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onReplay: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: { id: string; code: number; preserveRendererBinding?: boolean }) => void)
    | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onReplay = null
    onExit = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      replay: (callback) => {
        onReplay = callback
      },
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('ignores a stale exit for a previous PTY after reconnecting the same transport', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onPtyExit = vi.fn()
    spawn.mockResolvedValueOnce({ id: 'pty-old' }).mockResolvedValueOnce({ id: 'pty-new' })

    const transport = createIpcPtyTransport({ onPtyExit })

    await transport.connect({ url: '', callbacks: {} })
    await transport.connect({ url: '', callbacks: {} })

    onExit?.({ id: 'pty-old', code: 0 })

    expect(onPtyExit).not.toHaveBeenCalledWith('pty-old')
    expect(transport.getPtyId()).toBe('pty-new')
    expect(transport.isConnected()).toBe(true)

    onExit?.({ id: 'pty-new', code: 0 })

    expect(onPtyExit).toHaveBeenCalledWith('pty-new')
    expect(transport.getPtyId()).toBeNull()
    expect(transport.isConnected()).toBe(false)
  })

  it('ignores stale data and replay for a previous PTY after reconnecting the same transport', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()
    spawn.mockResolvedValueOnce({ id: 'pty-old' }).mockResolvedValueOnce({ id: 'pty-new' })

    const transport = createIpcPtyTransport({})

    await transport.connect({
      url: '',
      callbacks: { onData: vi.fn(), onReplayData: vi.fn() }
    })
    await transport.connect({
      url: '',
      callbacks: { onData: onDataCallback, onReplayData }
    })

    onData?.({ id: 'pty-old', data: 'old data' })
    onReplay?.({ id: 'pty-old', data: 'old replay' })

    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onReplayData).not.toHaveBeenCalled()

    onData?.({ id: 'pty-new', data: 'new data' })
    onReplay?.({ id: 'pty-new', data: 'new replay' })

    expect(onDataCallback).toHaveBeenCalledWith('new data')
    expect(onReplayData).toHaveBeenCalledWith('new replay')
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
    await flushPtySideEffects()
    expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

    // Simulate shutdownWorktreeTerminals: unregister data handlers before kill.
    const snapshots = unregisterPtyDataHandlers(['pty-1'])

    // Final burst after the handler was removed: its title change and BEL must not produce a notification.
    onData?.({ id: 'pty-1', data: ']0;Claude done' })
    expect(onAgentBecameIdle).not.toHaveBeenCalled()
    expect(onBell).not.toHaveBeenCalled()

    for (const snapshot of snapshots) {
      snapshot.commit()
    }

    // Exit handler should still work (exit handlers are kept alive)
    onExit?.({ id: 'pty-1', code: -1 })
    expect(onPtyExit).toHaveBeenCalledWith('pty-1')
  })

  it('marks a host reversible-stop exit before delivering it to the pane', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { consumeCommittedPtyShutdownExit } = await import('./pty-shutdown-exit-deferral')
    const transport = createIpcPtyTransport()
    await transport.connect({ url: '', callbacks: {} })

    onExit?.({ id: 'pty-1', code: 0, preserveRendererBinding: true })

    expect(consumeCommittedPtyShutdownExit('pty-1')).toBe(true)
  })

  it('restores data handlers when an intentional shutdown fails before exit', async () => {
    const {
      createIpcPtyTransport,
      restorePtyDataHandlersAfterFailedShutdown,
      unregisterPtyDataHandlers
    } = await import('./pty-transport')
    const onDataCallback = vi.fn()
    const transport = createIpcPtyTransport()

    await transport.connect({ url: '', callbacks: { onData: onDataCallback } })

    const snapshots = unregisterPtyDataHandlers(['pty-1'])
    onData?.({ id: 'pty-1', data: 'final burst while detached' })
    expect(onDataCallback).not.toHaveBeenCalled()

    restorePtyDataHandlersAfterFailedShutdown(snapshots)
    expect(onDataCallback).toHaveBeenCalledWith('final burst while detached')
    onData?.({ id: 'pty-1', data: 'live again' })

    expect(onDataCallback).toHaveBeenCalledWith('live again')
  })

  it('retains rollback replay until a pane detached during sleep registers again', async () => {
    const {
      createIpcPtyTransport,
      restorePtyDataHandlersAfterFailedShutdown,
      unregisterPtyDataHandlers
    } = await import('./pty-transport')
    const first = createIpcPtyTransport()
    await first.connect({ url: '', callbacks: { onReplayData: vi.fn() } })

    const snapshots = unregisterPtyDataHandlers(['pty-1'])
    onReplay?.({ id: 'pty-1', data: 'rollback replay while hidden' })
    first.destroy?.()
    restorePtyDataHandlersAfterFailedShutdown(snapshots)

    const replayedAfterAttach = vi.fn()
    const replacement = createIpcPtyTransport()
    await replacement.connect({
      url: '',
      callbacks: { onReplayData: replayedAfterAttach }
    })

    expect(replayedAfterAttach).toHaveBeenCalledWith('rollback replay while hidden')
  })

  it('keeps handlers suspended until every overlapping shutdown owner rolls back', async () => {
    const {
      createIpcPtyTransport,
      restorePtyDataHandlersAfterFailedShutdown,
      unregisterPtyDataHandlers
    } = await import('./pty-transport')
    const { ptyDataSidecars } = await import('./pty-dispatcher')
    const onDataCallback = vi.fn()
    const sidecar = vi.fn()
    const transport = createIpcPtyTransport()

    await transport.connect({ url: '', callbacks: { onData: onDataCallback } })

    const first = unregisterPtyDataHandlers(['pty-1'])
    const second = unregisterPtyDataHandlers(['pty-1'])
    ptyDataSidecars.set('pty-1', new Set([sidecar]))
    onData?.({ id: 'pty-1', data: 'buffered while both owners are pending' })

    restorePtyDataHandlersAfterFailedShutdown(first)
    expect(onDataCallback).not.toHaveBeenCalled()
    expect(sidecar).not.toHaveBeenCalled()

    restorePtyDataHandlersAfterFailedShutdown(second)
    expect(onDataCallback).toHaveBeenCalledWith('buffered while both owners are pending')
    expect(sidecar).toHaveBeenCalledWith('buffered while both owners are pending')
    ptyDataSidecars.delete('pty-1')
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
      vi.advanceTimersByTime(0)
      expect(onAgentBecameWorking).toHaveBeenCalledTimes(1)

      // Data arrives without a title change — starts the 3 s staleTitleTimer
      onData?.({ id: 'pty-1', data: 'some output without title\r\n' })
      vi.advanceTimersByTime(0)

      // Unregister must cancel the staleTitleTimer and reset the tracker so no stale idle transition fires.
      const snapshots = unregisterPtyDataHandlers(['pty-1'])

      // Advance past the 3 s stale-title timeout
      vi.advanceTimersByTime(4000)

      // The staleTitleTimer must NOT have fired onAgentBecameIdle
      expect(onAgentBecameIdle).not.toHaveBeenCalled()
      for (const snapshot of snapshots) {
        snapshot.commit()
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
