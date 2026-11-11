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

  it.each([
    { id: 'original', incarnationId: 'new-incarnation', isReattach: true },
    { id: 'original', isReattach: true },
    { id: 'other', incarnationId: 'original-incarnation', isReattach: true },
    { id: 'original', incarnationId: 'original-incarnation' }
  ])('does not attach, publish data or retire a different Restart owner: %j', async (result) => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const spawn = vi.mocked(window.api.pty.spawn)
    spawn.mockResolvedValueOnce(result)
    const onDataCallback = vi.fn()
    const onConnect = vi.fn()
    const transport = createIpcPtyTransport({})
    expect(
      await transport.connect({
        url: '',
        sessionId: 'original',
        attachOnlyView: true,
        expectedAttachIncarnationId: 'original-incarnation',
        callbacks: { onData: onDataCallback, onConnect }
      })
    ).toBeUndefined()
    onData?.({ id: result.id, data: 'winner output' })
    expect(transport.getPtyId()).toBeNull()
    expect(onDataCallback).not.toHaveBeenCalled()
    expect(onConnect).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it('obtains host proof for an attach-only Restart even after its old buffer was discarded', async () => {
    const { discardPreHandlerPtyState } = await import('../delivery/pty-pre-handler-buffer')
    const { createIpcPtyTransport } = await import('./pty-transport')
    discardPreHandlerPtyState('original')
    vi.mocked(window.api.pty.spawn).mockResolvedValueOnce({
      id: 'original',
      incarnationId: 'original-incarnation',
      isReattach: true
    })
    const transport = createIpcPtyTransport({ command: 'replacement-command' })
    const result = await transport.connect({
      url: '',
      sessionId: 'original',
      attachOnlyView: true,
      expectedAttachIncarnationId: 'original-incarnation',
      callbacks: {}
    })
    expect(window.api.pty.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'original',
        attachOnlyView: true
      })
    )
    expect(vi.mocked(window.api.pty.spawn).mock.calls[0][0]).not.toHaveProperty(
      'expectedAttachIncarnationId'
    )
    expect(result).toEqual(
      expect.objectContaining({
        id: 'original',
        incarnationId: 'original-incarnation',
        isReattach: true
      })
    )
    expect(transport.getPtyId()).toBe('original')
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })
})
