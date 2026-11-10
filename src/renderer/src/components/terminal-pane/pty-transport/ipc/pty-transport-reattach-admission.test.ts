import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onData: ((payload: { id: string; data: string }) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onData = null
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        onData = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
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

  it('delivers a buffered dead-session exit without respawning the same session id', async () => {
    const { bufferPreHandlerPtyData, bufferPreHandlerPtyExit } =
      await import('../delivery/pty-pre-handler-buffer')
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
    expect(onPtyExit).toHaveBeenCalledWith(sessionId, 17)
    expect(transport.isConnected()).toBe(false)
  })
})
