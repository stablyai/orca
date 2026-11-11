import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onReplay: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onReplay = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      replay: (callback) => {
        onReplay = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('retains rollback replay until a pane detached during sleep registers again', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    await import('../delivery/pty-dispatcher')
    const { restorePtyDataHandlersAfterFailedShutdown, unregisterPtyDataHandlers } =
      await import('../shutdown/pty-shutdown-data-suspension')
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
    const { createIpcPtyTransport } = await import('./pty-transport')
    await import('../delivery/pty-dispatcher')
    const { restorePtyDataHandlersAfterFailedShutdown, unregisterPtyDataHandlers } =
      await import('../shutdown/pty-shutdown-data-suspension')
    await import('../delivery/pty-dispatcher')
    const { ptyDataSidecars } = await import('../shutdown/pty-shutdown-data-suspension')
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
})
