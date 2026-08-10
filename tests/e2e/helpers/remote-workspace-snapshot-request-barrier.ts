import type { ElectronApplication } from '@stablyai/playwright-test'

type InvokeHandler = (event: unknown, args?: { targetId?: string }) => unknown

type BarrierState = {
  targetId: string
  captured: boolean
  released: boolean
  release: () => void
  originalHandler: InvokeHandler
  handlerReturned: Promise<void>
  markHandlerReturned: () => void
}

export async function installRemoteWorkspaceSnapshotRequestBarrier(
  app: ElectronApplication,
  targetId: string
): Promise<void> {
  await app.evaluate(({ ipcMain }, targetId) => {
    const scope = globalThis as typeof globalThis & {
      __remoteWorkspaceSnapshotRequestBarrier?: BarrierState
    }
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const originalHandler = handlers?.get('remoteWorkspace:get')
    if (!handlers || !originalHandler || scope.__remoteWorkspaceSnapshotRequestBarrier) {
      throw new Error('remoteWorkspace:get barrier is unavailable or already installed')
    }
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let markHandlerReturned!: () => void
    const handlerReturned = new Promise<void>((resolve) => {
      markHandlerReturned = resolve
    })
    const state: BarrierState = {
      targetId,
      captured: false,
      released: false,
      release,
      originalHandler,
      handlerReturned,
      markHandlerReturned
    }
    scope.__remoteWorkspaceSnapshotRequestBarrier = state
    handlers.set('remoteWorkspace:get', async (event, args) => {
      if (state.captured || args?.targetId !== state.targetId) {
        return state.originalHandler(event, args)
      }
      const snapshot = await state.originalHandler(event, args)
      state.captured = true
      await barrier
      state.markHandlerReturned()
      return snapshot
    })
  }, targetId)
}

export async function readRemoteWorkspaceSnapshotRequestBarrier(
  app: ElectronApplication
): Promise<{ captured: boolean; released: boolean }> {
  return app.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __remoteWorkspaceSnapshotRequestBarrier?: BarrierState
      }
    ).__remoteWorkspaceSnapshotRequestBarrier
    return { captured: state?.captured ?? false, released: state?.released ?? false }
  })
}

export async function releaseRemoteWorkspaceSnapshotRequestBarrier(
  app: ElectronApplication
): Promise<void> {
  await app.evaluate(async () => {
    const state = (
      globalThis as typeof globalThis & {
        __remoteWorkspaceSnapshotRequestBarrier?: BarrierState
      }
    ).__remoteWorkspaceSnapshotRequestBarrier
    if (state && !state.released) {
      state.released = true
      state.release()
    }
    await state?.handlerReturned
  })
}

export async function restoreRemoteWorkspaceSnapshotRequestHandler(
  app: ElectronApplication
): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as typeof globalThis & {
      __remoteWorkspaceSnapshotRequestBarrier?: BarrierState
    }
    const state = scope.__remoteWorkspaceSnapshotRequestBarrier
    if (!state) {
      return
    }
    if (!state.released) {
      state.released = true
      state.release()
    }
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    handlers?.set('remoteWorkspace:get', state.originalHandler)
    delete scope.__remoteWorkspaceSnapshotRequestBarrier
  })
}
