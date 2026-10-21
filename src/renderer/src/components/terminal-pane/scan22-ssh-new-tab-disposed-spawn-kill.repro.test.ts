import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

// Scan-22 repro: a new SSH tab whose pane remounts while its first pty:spawn is in flight.
// Main's pane-spawn reservation hands the successor the SAME PTY id; the disposed
// predecessor then killed it on resolve (tab closes on pty-exit, or goes input-dead).
describe('scan22: disposed mid-spawn SSH transport vs successor on the same PTY', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })
  afterEach(() => restorePtySpecWindow(originalWindow))

  it('does not kill the PTY the remounted successor is bound to', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    let resolveFirst: (value: { id: string }) => void = () => {}
    const spawn = vi.mocked(window.api.pty.spawn)
    spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    // Successor is handed the same id by main's (worktree, connection, paneKey) reservation.
    spawn.mockResolvedValueOnce({ id: 'ssh-conn@@pty-7' })
    // As installPtyInputRecovery wires it: the tab and its leaf still exist in the store.
    const paneOptions = {
      connectionId: 'ssh-conn',
      worktreeId: 'wt',
      tabId: 'tab-2',
      leafId: 'leaf-a',
      retainDisposedSpawn: () => true
    }

    const first = createIpcPtyTransport(paneOptions)
    const firstConnect = first.connect({ url: '', callbacks: {} })
    // Pane remount (generation bump / recovery / park flip) while spawn is in flight.
    first.destroy?.()

    const successor = createIpcPtyTransport(paneOptions)
    await successor.connect({ url: '', callbacks: {} })
    expect(successor.getPtyId()).toBe('ssh-conn@@pty-7')

    resolveFirst({ id: 'ssh-conn@@pty-7' })
    await firstConnect

    expect(window.api.pty.kill).not.toHaveBeenCalledWith('ssh-conn@@pty-7')
  })
})
