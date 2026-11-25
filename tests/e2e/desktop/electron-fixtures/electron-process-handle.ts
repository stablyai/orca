import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'

const processByApp = new WeakMap<ElectronApplication, ChildProcess>()

// Playwright disposes its process dispatcher when Electron exits; retain the handle for cleanup.
export function getElectronProcessForE2E(app: ElectronApplication): ChildProcess {
  let proc = processByApp.get(app)
  if (!proc) {
    proc = app.process()
    processByApp.set(app, proc)
  }
  return proc
}
