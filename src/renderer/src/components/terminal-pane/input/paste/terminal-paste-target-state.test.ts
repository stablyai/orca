import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeferred } from '../../pty-connection/test-fixtures/pty-connection-test-async'
import {
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../../pty-transport/ipc/pty-transport-test-harness'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'

describe('isTerminalPanePasteTargetCurrent', () => {
  const originalWindow = globalThis.window
  const manager = { getPanes: () => [{ id: 1, leafId: 'leaf-1' }] }

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  const isCurrent = (transport: PtyTransport, ptyId: string | null): boolean =>
    isTerminalPanePasteTargetCurrent({
      manager,
      paneTransports: new Map([[1, transport]]),
      paneId: 1,
      leafId: 'leaf-1',
      transport,
      ptyId
    })

  it('accepts a paste into a starting terminal that holds typed input until it connects', async () => {
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValue(spawn.promise)
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const transport = createIpcPtyTransport({ bufferInputUntilConnect: true })

    const connecting = transport.connect({ url: '', callbacks: {} })
    expect(isCurrent(transport, null)).toBe(true)

    spawn.resolve({ id: 'pty-1' })
    await connecting
    expect(isCurrent(transport, null)).toBe(true)
    expect(isCurrent(transport, 'pty-1')).toBe(true)
    expect(isCurrent(transport, 'pty-0')).toBe(false)

    transport.disconnect()
    expect(isCurrent(transport, null)).toBe(false)
  })
})
