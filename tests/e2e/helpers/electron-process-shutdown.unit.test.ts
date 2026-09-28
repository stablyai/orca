import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeElectronAppForE2E } from './electron-process-shutdown'

function exitedAppFixture() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()]
  })
  const pipesClosed = Promise.all(
    proc.stdio.map((stream) => new Promise<void>((resolve) => stream.once('close', resolve)))
  )
  const close = vi.fn(() => pipesClosed)
  const app = {
    process: () => proc as unknown as ChildProcess,
    close
  } as unknown as ElectronApplication
  return { proc, app, close }
}

afterEach(() => vi.useRealTimers())

describe('Electron shutdown with inherited pipes', () => {
  it('releases retained pipes only after Electron exits, settling Playwright cleanup', async () => {
    const { proc, app, close } = exitedAppFixture()
    const closing = closeElectronAppForE2E(app)
    expect(close).toHaveBeenCalledOnce()
    expect(proc.stdio.every((stream) => !stream.destroyed)).toBe(true)
    proc.exitCode = 0
    proc.emit('exit', 0, null)
    await closing
    expect(proc.stdio.every((stream) => stream.destroyed)).toBe(true)
    expect(proc.listenerCount('exit')).toBe(0)
  })

  it('releases pipes when Electron already exited before cleanup starts', async () => {
    const { proc, app } = exitedAppFixture()
    proc.exitCode = 0
    await closeElectronAppForE2E(app)
    expect(proc.stdio.every((stream) => stream.destroyed)).toBe(true)
  })

  it('does not release pipes if shutdown times out without confirmed process exit', async () => {
    vi.useFakeTimers()
    const { proc, app } = exitedAppFixture()
    const closing = closeElectronAppForE2E(app)
    await vi.advanceTimersByTimeAsync(10_000)
    await closing
    expect(proc.stdio.every((stream) => !stream.destroyed)).toBe(true)
    expect(proc.listenerCount('exit')).toBe(0)
    for (const stream of proc.stdio) {
      stream.destroy()
    }
  })
})
