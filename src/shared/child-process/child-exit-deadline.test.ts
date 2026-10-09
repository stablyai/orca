import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armChildExitDeadline } from './child-exit-deadline'
import { spawnProcess } from './run-process'
import {
  blockEventLoopUntilChildFinished,
  finishingChildScript
} from './__fixtures__/blocked-event-loop'

let markerDir: string

function spawnNode(script: string): ReturnType<typeof spawnProcess> {
  const child = spawnProcess({ program: process.execPath, args: ['-e', script] })
  child.stdout.resume()
  child.stderr.resume()
  return child
}

function waitForClose(child: ReturnType<typeof spawnProcess>): Promise<void> {
  return new Promise((resolve) => child.once('close', () => resolve()))
}

beforeEach(() => {
  markerDir = mkdtempSync(join(tmpdir(), 'orca-child-exit-deadline-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(markerDir, { recursive: true, force: true })
})

describe('armChildExitDeadline', () => {
  it('does not expire a child that exited while the event loop was blocked past the deadline', async () => {
    const marker = join(markerDir, 'finished')
    const child = spawnNode(finishingChildScript(marker, 'done'))
    const onExpired = vi.fn()
    const deadline = armChildExitDeadline(child, 100, onExpired)
    const closed = waitForClose(child).then(() => deadline.clear())

    blockEventLoopUntilChildFinished(marker, 300)
    await closed
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(onExpired).not.toHaveBeenCalled()
  })

  it('expires a child that is still running at the deadline', async () => {
    const child = spawnNode('setInterval(() => {}, 1000)')
    try {
      await new Promise<void>((resolve) => armChildExitDeadline(child, 100, resolve))
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('still expires when the child exited but a descendant keeps its stdio open', async () => {
    const child = spawnNode(
      'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit" }); process.exit(0)'
    )
    const onExpired = vi.fn()
    armChildExitDeadline(child, 100, onExpired)
    await new Promise((resolve) => child.once('exit', resolve))

    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledOnce(), { timeout: 2_500 })
  })

  it('never fires once cleared', async () => {
    vi.useFakeTimers()
    const onExpired = vi.fn()
    const deadline = armChildExitDeadline({ exitCode: null, signalCode: null }, 100, onExpired)

    deadline.clear()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(onExpired).not.toHaveBeenCalled()
  })
})
