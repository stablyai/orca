import type { ElectronApplication } from '@stablyai/playwright-test'
import { describe, expect, it, vi } from 'vitest'
import {
  installSshPortForwardSnapshotBarrier,
  readSshPortForwardSnapshotBarrier,
  releaseSshPortForwardSnapshotBarrier,
  restoreSshPortForwardSnapshotHandler
} from './ssh-port-forward-snapshot-barrier'

type InvokeHandler = (event: unknown, args?: { targetId?: string }) => unknown

describe('SSH port-forward snapshot barrier', () => {
  it('holds only the first matching request while its snapshot is unresolved', async () => {
    const handlers = new Map<string, InvokeHandler>()
    let resolveFirstSnapshot: (value: string[]) => void = () => {}
    const firstSnapshot = new Promise<string[]>((resolve) => {
      resolveFirstSnapshot = resolve
    })
    let callCount = 0
    const originalHandler = vi.fn(() => {
      callCount += 1
      return callCount === 1 ? firstSnapshot : Promise.resolve(['later-snapshot'])
    })
    handlers.set('ssh:listPortForwards', originalHandler)
    const app = {
      evaluate: (
        callback: (electron: unknown, arg?: unknown) => unknown,
        arg?: unknown
      ): Promise<unknown> =>
        Promise.resolve(callback({ ipcMain: { _invokeHandlers: handlers } }, arg))
    } as unknown as ElectronApplication

    let heldRequestStarted = false
    await installSshPortForwardSnapshotBarrier(app, 'target-1')
    try {
      const wrappedHandler = handlers.get('ssh:listPortForwards')
      expect(wrappedHandler).toBeTypeOf('function')
      if (!wrappedHandler) {
        throw new Error('Wrapped handler unavailable')
      }

      heldRequestStarted = true
      const firstRequest = Promise.resolve(wrappedHandler({}, { targetId: 'target-1' }))
      await vi.waitFor(() => expect(originalHandler).toHaveBeenCalledOnce())
      const laterRequest = Promise.resolve(wrappedHandler({}, { targetId: 'target-1' }))
      await expect(laterRequest).resolves.toEqual(['later-snapshot'])
      expect(await readSshPortForwardSnapshotBarrier(app)).toEqual({
        captured: false,
        released: false
      })

      resolveFirstSnapshot(['held-snapshot'])
      await vi.waitFor(async () => {
        expect(await readSshPortForwardSnapshotBarrier(app)).toEqual({
          captured: true,
          released: false
        })
      })
      await releaseSshPortForwardSnapshotBarrier(app)
      await expect(firstRequest).resolves.toEqual(['held-snapshot'])
    } finally {
      resolveFirstSnapshot(['cleanup-snapshot'])
      if (heldRequestStarted) {
        await releaseSshPortForwardSnapshotBarrier(app)
      }
      await restoreSshPortForwardSnapshotHandler(app)
    }
  })
})
