import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null
  let onReplay: ((payload: { id: string; data: string }) => void) | null = null
  let onExit:
    | ((payload: { id: string; code: number; preserveRendererBinding?: boolean }) => void)
    | null = null
  let onWriteUnavailable: ((payload: { id: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    onReplay = null
    onExit = null
    onWriteUnavailable = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      },
      replay: (callback) => {
        onReplay = callback
      },
      exit: (callback) => {
        onExit = callback
      },
      writeUnavailable: (callback) => {
        onWriteUnavailable = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('does not create a second kill authority when a mounted pane detaches', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })

    transport.detach?.()

    expect(kill).not.toHaveBeenCalled()
  })

  // Why: retained gauges would inflate every later high-water profile.
  it.each(['detach', 'destroy'] as const)(
    'drops its side-effect gauge from the census on %s',
    async (teardown) => {
      await import('./pty-side-effect-pending-census')
      const { collectRendererMemoryProfileCounts } = await import('@/lib/renderer-memory-profile')
      const { createIpcPtyTransport } = await import('./pty-transport')
      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(0)

      const transport = createIpcPtyTransport({})
      await transport.connect({ url: '', callbacks: {} })
      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(1)

      transport[teardown]?.()

      expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(0)
    }
  )

  // Why: teardown that already failed is exactly when a stranded gauge would pin the processor.
  it('drops its side-effect gauge even when destroy throws mid-disconnect', async () => {
    await import('./pty-side-effect-pending-census')
    const { collectRendererMemoryProfileCounts } = await import('@/lib/renderer-memory-profile')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })
    expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(1)

    kill.mockImplementationOnce(() => {
      throw new Error('ipc channel closed')
    })

    expect(() => transport.destroy?.()).toThrow('ipc channel closed')
    expect(collectRendererMemoryProfileCounts()['ptySideEffects.processors']).toBe(0)
  })

  it('keeps the live handler when detach() runs after a newer transport attached to the same PTY', async () => {
    // Why: a new pane can attach the same ptyId before the old detaches; unconditional unregister deletes the live handler (frozen-pane bug).
    const { createIpcPtyTransport } = await import('./pty-transport')
    const receivedByNewPane = vi.fn()
    const replayedToNewPane = vi.fn()
    const exitSeenByNewPane = vi.fn()
    const receivedByOldPane = vi.fn()

    const oldPane = createIpcPtyTransport({})
    await oldPane.connect({ url: '', callbacks: { onData: receivedByOldPane } })

    const newPane = createIpcPtyTransport({})
    newPane.attach?.({
      existingPtyId: 'pty-1',
      callbacks: {
        onData: receivedByNewPane,
        onReplayData: replayedToNewPane,
        onExit: exitSeenByNewPane
      }
    })
    oldPane.detach?.()

    onData?.({ id: 'pty-1', data: 'live output' })
    onReplay?.({ id: 'pty-1', data: 'replay output' })

    expect(receivedByNewPane).toHaveBeenCalledWith('live output')
    expect(replayedToNewPane).toHaveBeenCalledWith('replay output')
    expect(receivedByOldPane).not.toHaveBeenCalled()

    onExit?.({ id: 'pty-1', code: 0 })
    expect(exitSeenByNewPane).toHaveBeenCalledWith(0)
  })

  it('buffers data across a normal detach-then-attach gap and drains it to the next pane', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const receivedByNewPane = vi.fn()

    const oldPane = createIpcPtyTransport({})
    await oldPane.connect({ url: '', callbacks: { onData: vi.fn() } })
    oldPane.detach?.()

    onData?.({ id: 'pty-1', data: 'buffered while detached' })
    expect(receivedByNewPane).not.toHaveBeenCalled()

    const newPane = createIpcPtyTransport({})
    newPane.attach?.({
      existingPtyId: 'pty-1',
      callbacks: { onData: receivedByNewPane }
    })

    expect(receivedByNewPane).toHaveBeenCalledWith('buffered while detached')

    onData?.({ id: 'pty-1', data: 'live after reattach' })
    expect(receivedByNewPane).toHaveBeenCalledWith('live after reattach')
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

    expect(onPtyExit).toHaveBeenCalledWith('pty-detached', 0)
    expect(transport.getPtyId()).toBeNull()
  })

  it('drops the exit observer when abandoning an obsolete reattach without killing it', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const onPtyExit = vi.fn()
    const kill = window.api.pty.kill as unknown as ReturnType<typeof vi.fn>
    const transport = createIpcPtyTransport({ onPtyExit })
    const onDataCallback = vi.fn()
    const onReplayData = vi.fn()
    const onWriteUnavailableCallback = vi.fn()
    const onExitCallback = vi.fn()
    const onDisconnect = vi.fn()

    transport.attach({
      existingPtyId: 'pty-obsolete',
      callbacks: {
        onData: onDataCallback,
        onReplayData,
        onWriteUnavailable: onWriteUnavailableCallback,
        onExit: onExitCallback,
        onDisconnect
      }
    })
    transport.detach?.({ preserveExitObserver: false })
    onData?.({ id: 'pty-obsolete', data: 'stale data' })
    onReplay?.({ id: 'pty-obsolete', data: 'stale replay' })
    onWriteUnavailable?.({ id: 'pty-obsolete' })
    onExit?.({ id: 'pty-obsolete', code: 0 })

    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onReplayData).not.toHaveBeenCalled()
    expect(onWriteUnavailableCallback).not.toHaveBeenCalled()
    expect(onExitCallback).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })
})
