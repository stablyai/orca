import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../windows-transient-lock-removal'
import { runProcess, spawnProcess } from '@orca/process-host'
import { _setWindowsTaskkillLauncherForTests } from '@orca/process-host/windows-tree-kill'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'

/**
 * A loaded Windows host can take 5-18 s to finish `taskkill /t /f`. The barrier
 * must leave that taskkill running past its caller's wait, and must not kill the
 * root first: a root killed before taskkill reads the tree orphans the grandchild.
 *
 * Runs only on win32. `ORCA_WINDOWS_TREE_KILL_LOAD=1` adds CPU burners and runs
 * the unmodified taskkill too; CI runs that in its own step so the burners never
 * share the machine with other test files.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip
const underLoad = process.env.ORCA_WINDOWS_TREE_KILL_LOAD === '1'
// Longer than the caller's 5 s wait, well inside the 30 s deadline.
const TASKKILL_START_DELAY_MS = 8_000

describeOnWindows('Windows barrier with a taskkill slower than its caller', () => {
  let dir: string
  let burners: ChildProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-late-taskkill-'))
    writeFileSync(
      join(dir, 'hang.js'),
      `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'grandchild.pid'), String(process.pid)); setInterval(function () {}, 60000);`
    )
    writeFileSync(join(dir, 'hung.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0hang.js"\r\n`)
  })

  afterEach(async () => {
    _setWindowsTaskkillLauncherForTests(null)
    await Promise.all(
      burners.map(async (burner) => {
        if (burner.exitCode !== null || burner.signalCode !== null) {
          return
        }
        const closed = new Promise<void>((resolve) => burner.once('close', () => resolve()))
        burner.kill()
        await closed
      })
    )
    burners = []
    const pidFile = join(dir, 'grandchild.pid')
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      } catch {
        /* already gone, as the test expects */
      }
    }
    removeTreeSync(dir)
  })

  async function waitForGrandchildPid(signal: AbortSignal): Promise<number> {
    const pidFile = join(dir, 'grandchild.pid')
    const deadline = Date.now() + 30_000
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
      signal.throwIfAborted()
      if (Date.now() > deadline) {
        throw new Error('the grandchild never started')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return Number(readFileSync(pidFile, 'utf8'))
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('kills the grandchild when taskkill finishes after the caller stopped waiting', async ({
    signal
  }) => {
    _setWindowsTaskkillLauncherForTests((rootPid) =>
      spawnProcess({
        program: process.execPath,
        args: [
          '-e',
          `setTimeout(function () {
              var r = require('node:child_process').spawnSync(process.argv[1], ['/pid', process.argv[2], '/t', '/f'], { stdio: 'ignore', windowsHide: true });
              process.exit(r.status === null ? 1 : r.status);
            }, ${TASKKILL_START_DELAY_MS});`,
          windowsSystem32Binary('taskkill.exe'),
          String(rootPid)
        ],
        stdio: 'ignore'
      })
    )
    await expectBarrierKillsGrandchild(signal)
  }, 90_000)

  it.skipIf(!underLoad)(
    'kills the grandchild with the real taskkill on a loaded host',
    async ({ signal }) => {
      let taskkillOutcome = 'still running'
      _setWindowsTaskkillLauncherForTests((rootPid) => {
        const startedAt = Date.now()
        const taskkill = spawnProcess({
          program: windowsSystem32Binary('taskkill.exe'),
          args: ['/pid', String(rootPid), '/t', '/f'],
          stdio: 'ignore'
        })
        taskkill.once('close', (code, signal) => {
          taskkillOutcome = `${Date.now() - startedAt} ms, code ${code}, signal ${signal}`
        })
        return taskkill
      })
      await expectBarrierKillsGrandchild(signal)
      // Evidence only: how slow this load made taskkill (about 50 ms idle).
      console.log(`[late-taskkill] taskkill under load: ${taskkillOutcome}`)
    },
    90_000
  )

  async function expectBarrierKillsGrandchild(signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    let reportedAt: number | undefined
    const pending = runProcess({
      program: join(dir, 'hung.cmd'),
      timeoutMs: null,
      signal: AbortSignal.any([controller.signal, signal]),
      terminationBarrier: true,
      onChildTerminated: () => {
        reportedAt = Date.now()
      }
    })
    try {
      const grandchild = await waitForGrandchildPid(signal)
      expect(isAlive(grandchild)).toBe(true)
      if (underLoad) {
        // Load the shutdown, after the fixture has proved it can start.
        const readyFiles = Array.from({ length: availableParallelism() * 2 }, (_, index) =>
          join(dir, `burner-${index}.ready`)
        )
        burners = readyFiles.map((ready) =>
          spawnProcess({
            program: process.execPath,
            args: [
              '-e',
              "require('node:fs').writeFileSync(process.argv[1], 'ready'); for (;;) {}",
              ready
            ],
            stdio: 'ignore'
          })
        )
        await expect
          .poll(() => readyFiles.every((ready) => existsSync(ready)), { timeout: 30_000 })
          .toBe(true)
      }

      const abortedAt = Date.now()
      controller.abort()
      await pending
      const settledAfterMs = Date.now() - abortedAt
      await expect.poll(() => reportedAt, { timeout: 30_000 }).toBeDefined()
      const reportedAfterMs = reportedAt === undefined ? null : reportedAt - abortedAt
      console.log(
        `[late-taskkill] caller settled ${settledAfterMs} ms, termination reported ${reportedAfterMs} ms after abort`
      )
      // TerminateProcess returns before the pid is fully released, so allow a short drain.
      const goneBy = Date.now() + 5_000
      while (isAlive(grandchild) && Date.now() < goneBy) {
        signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(isAlive(grandchild)).toBe(false)
    } finally {
      controller.abort()
      await pending
    }
  }
})
