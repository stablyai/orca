import { createServer } from 'node:net'

import type { ElectronApplication } from '@stablyai/playwright-test'

type InvokeHandler = (event: unknown, args?: { targetId?: string }) => unknown

type SnapshotBarrierState = {
  targetId: string
  captureClaimed: boolean
  captured: boolean
  released: boolean
  release: () => void
  originalHandler: InvokeHandler
  handlerReturned: Promise<void>
  markHandlerReturned: () => void
}

export type ReservedLocalPort = {
  port: number
  release: () => Promise<void>
}

export async function reserveLocalPort(): Promise<ReservedLocalPort> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Unable to reserve a local port')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) {
        return
      }
      released = true
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

export async function installSshPortForwardSnapshotBarrier(
  app: ElectronApplication,
  targetId: string
): Promise<void> {
  await app.evaluate(({ ipcMain }, targetId) => {
    const scope = globalThis as typeof globalThis & {
      __sshPortForwardSnapshotBarrier?: SnapshotBarrierState
    }
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers?: Map<string, InvokeHandler>
      }
    )._invokeHandlers
    const originalHandler = handlers?.get('ssh:listPortForwards')
    if (!handlers || !originalHandler) {
      throw new Error('ssh:listPortForwards handler is unavailable')
    }
    if (scope.__sshPortForwardSnapshotBarrier) {
      throw new Error('SSH port-forward snapshot barrier is already installed')
    }
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let markHandlerReturned!: () => void
    const handlerReturned = new Promise<void>((resolve) => {
      markHandlerReturned = resolve
    })
    const state: SnapshotBarrierState = {
      targetId,
      captureClaimed: false,
      captured: false,
      released: false,
      release,
      originalHandler,
      handlerReturned,
      markHandlerReturned
    }
    scope.__sshPortForwardSnapshotBarrier = state
    handlers.set('ssh:listPortForwards', async (event, args) => {
      if (state.captureClaimed || args?.targetId !== state.targetId) {
        return state.originalHandler(event, args)
      }
      state.captureClaimed = true
      const snapshot = await state.originalHandler(event, args)
      state.captured = true
      await barrier
      state.markHandlerReturned()
      return snapshot
    })
  }, targetId)
}

export async function readSshPortForwardSnapshotBarrier(
  app: ElectronApplication
): Promise<{ captured: boolean; released: boolean }> {
  return app.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __sshPortForwardSnapshotBarrier?: SnapshotBarrierState
      }
    ).__sshPortForwardSnapshotBarrier
    return {
      captured: state?.captured ?? false,
      released: state?.released ?? false
    }
  })
}

export async function releaseSshPortForwardSnapshotBarrier(
  app: ElectronApplication
): Promise<void> {
  await app.evaluate(async () => {
    const state = (
      globalThis as typeof globalThis & {
        __sshPortForwardSnapshotBarrier?: SnapshotBarrierState
      }
    ).__sshPortForwardSnapshotBarrier
    if (state && !state.released) {
      state.released = true
      state.release()
    }
    await state?.handlerReturned
  })
}

export async function restoreSshPortForwardSnapshotHandler(
  app: ElectronApplication
): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as typeof globalThis & {
      __sshPortForwardSnapshotBarrier?: SnapshotBarrierState
    }
    const state = scope.__sshPortForwardSnapshotBarrier
    if (!state) {
      return
    }
    if (!state.released) {
      state.released = true
      state.release()
    }
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers?: Map<string, InvokeHandler>
      }
    )._invokeHandlers
    handlers?.set('ssh:listPortForwards', state.originalHandler)
    delete scope.__sshPortForwardSnapshotBarrier
  })
}
