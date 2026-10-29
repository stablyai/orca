import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installIpcPtyWindow,
  restorePtySpecWindow,
  type PtyExitPayload
} from './pty-transport-test-harness'

describe('createIpcPtyTransport', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  let onExit: ((payload: PtyExitPayload) => void) | null = null

  beforeEach(() => {
    vi.resetModules()
    onExit = null
    installIpcPtyWindow(originalWindow, {
      exit: (callback) => {
        onExit = callback
      }
    })
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it.each(['onData', 'onExit'] as const)(
    'clears preconnect input and recovers after %s registration fails before binding',
    async (failedRegistration) => {
      const dataListeners = new Set<Parameters<typeof window.api.pty.onData>[0]>()
      const replayListeners = new Set<Parameters<typeof window.api.pty.onReplay>[0]>()
      vi.mocked(window.api.pty.onData).mockImplementation((callback) => {
        dataListeners.add(callback)
        return () => {
          dataListeners.delete(callback)
        }
      })
      vi.mocked(window.api.pty.onReplay).mockImplementation((callback) => {
        replayListeners.add(callback)
        return () => {
          replayListeners.delete(callback)
        }
      })
      vi.mocked(window.api.pty[failedRegistration]).mockImplementationOnce(() => {
        throw new Error('dispatcher attach failed')
      })
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })
      const accepted = transport.sendInputAccepted?.('input', 'driving')

      expect(() =>
        transport.attach({ existingPtyId: 'pty-attach-failure', callbacks: {} })
      ).toThrow('dispatcher attach failed')

      await expect(accepted).resolves.toBe(false)
      expect(transport.isConnected()).toBe(false)
      expect(transport.sendInput('after-failure', 'driving')).toBe(false)
      expect(dataListeners.size).toBe(0)
      expect(replayListeners.size).toBe(0)

      const data = vi.fn(),
        replay = vi.fn(),
        exited = vi.fn()
      transport.attach({
        existingPtyId: 'pty-attach-failure',
        callbacks: { onData: data, onReplayData: replay, onExit: exited }
      })
      for (const listener of dataListeners) {
        listener({ id: 'pty-attach-failure', data: 'recovered output' })
      }
      for (const listener of replayListeners) {
        listener({ id: 'pty-attach-failure', data: 'recovered replay' })
      }
      expect(data).toHaveBeenCalledExactlyOnceWith('recovered output')
      expect(replay).toHaveBeenCalledExactlyOnceWith('recovered replay')
      await expect(transport.sendInputAccepted?.('fresh', 'driving')).resolves.toBe(true)
      expect(window.api.pty.writeAccepted).toHaveBeenCalledExactlyOnceWith(
        'pty-attach-failure',
        'fresh',
        'driving'
      )
      onExit?.({ id: 'pty-attach-failure', code: 7 })
      expect(exited).toHaveBeenCalledExactlyOnceWith(7)
      expect(transport.isConnected()).toBe(false)
    }
  )
})
