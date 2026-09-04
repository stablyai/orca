import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { describe, expect, it, vi } from 'vitest'
import { closeElectronAppForE2E } from './electron-process-shutdown'

class FakeElectronProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid?: number
}

function createApp(proc: FakeElectronProcess, close: () => Promise<void>): ElectronApplication {
  return {
    close,
    process: () => proc as unknown as ChildProcess
  } as unknown as ElectronApplication
}

describe('closeElectronAppForE2E', () => {
  it('allows a clean Electron shutdown', async () => {
    const proc = new FakeElectronProcess()
    const app = createApp(proc, async () => {
      proc.exitCode = 0
      proc.emit('exit', 0, null)
    })

    await expect(closeElectronAppForE2E(app)).resolves.toBeUndefined()
  })

  it('fails when Electron reports a native crash exit code during shutdown', async () => {
    const proc = new FakeElectronProcess()
    const app = createApp(proc, async () => {
      proc.exitCode = 3221225477
      proc.emit('exit', 3221225477, null)
    })

    await expect(closeElectronAppForE2E(app)).rejects.toThrow(
      'Electron app exited abnormally during e2e shutdown: code=3221225477 signal=null'
    )
  })

  it('fails when Electron reports a signal during shutdown', async () => {
    const proc = new FakeElectronProcess()
    const app = createApp(proc, async () => {
      proc.signalCode = 'SIGSEGV'
      proc.emit('exit', null, 'SIGSEGV')
    })

    await expect(closeElectronAppForE2E(app)).rejects.toThrow(
      'Electron app exited abnormally during e2e shutdown: code=null signal=SIGSEGV'
    )
  })

  it('preserves existing cleanup tolerance when close itself fails first', async () => {
    const proc = new FakeElectronProcess()
    const app = createApp(
      proc,
      vi.fn(async () => {
        throw new Error('close failed')
      })
    )

    await expect(closeElectronAppForE2E(app)).resolves.toBeUndefined()
  })
})
