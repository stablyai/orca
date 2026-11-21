import type { ElectronApplication } from '@stablyai/playwright-test'

type StatusArgs = { worktreePath?: string; admissionTier?: string }
type StatusHandler = (event: unknown, args?: StatusArgs) => unknown
type RetryBarrier = {
  captured: boolean
  release: () => void
  original: StatusHandler
}
type BarrierScope = typeof globalThis & { __gitStatusRetryBarrier?: RetryBarrier }

export async function installGitStatusRetryBarrier(
  app: ElectronApplication,
  repoPath: string
): Promise<void> {
  await app.evaluate(({ ipcMain }, repoPath) => {
    const scope = globalThis as BarrierScope
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, StatusHandler> })
      ._invokeHandlers
    const original = handlers.get('git:status')
    if (!original || scope.__gitStatusRetryBarrier) {
      throw new Error('Git status handler unavailable or retry barrier already installed')
    }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const state: RetryBarrier = { captured: false, release, original }
    scope.__gitStatusRetryBarrier = state
    handlers.set('git:status', async (event, args) => {
      if (
        !state.captured &&
        args?.worktreePath === repoPath &&
        args.admissionTier === 'interactive'
      ) {
        state.captured = true
        await pending
      }
      return original(event, args)
    })
  }, repoPath)
}

export async function hasCapturedGitStatusRetry(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => (globalThis as BarrierScope).__gitStatusRetryBarrier?.captured ?? false)
}

export async function restoreGitStatusRetryHandler(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as BarrierScope
    const state = scope.__gitStatusRetryBarrier
    if (!state) {
      return
    }
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, StatusHandler> })
      ._invokeHandlers
    handlers.set('git:status', state.original)
    state.release()
    delete scope.__gitStatusRetryBarrier
  })
}
