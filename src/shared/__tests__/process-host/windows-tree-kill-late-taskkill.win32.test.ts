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
    if (underLoad) {
      const count = availableParallelism() * 2
      burners = Array.from({ length: count }, () =>
        spawnProcess({ program: process.execPath, args: ['-e', 'for (;;) {}'], stdio: 'ignore' })
      )
    }
  })

  afterEach(() => {
    _setWindowsTaskkillLauncherForTests(null)
    for (const burner of burners) {
      burner.kill()
    }
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

  async function waitForGrandchildPid(): Promise<number> {
    const pidFile = join(dir, 'grandchild.pid')
    const deadline = Date.now() + 30_000
    while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
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

  it('kills the grandchild when taskkill finishes after the caller stopped waiting', async () => {
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
    await expectBarrierKillsGrandchild()
  }, 90_000)

  it.skipIf(!underLoad)(
    'kills the grandchild with the real taskkill on a loaded host',
    async () => {
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
      await expectBarrierKillsGrandchild()
      // Evidence only: how slow this load made taskkill (about 50 ms idle).
      console.log(`[late-taskkill] taskkill under load: ${taskkillOutcome}`)
    },
    90_000
  )

  async function expectBarrierKillsGrandchild(): Promise<void> {
    const controller = new AbortController()
    let reportTerminated!: () => void
    const terminationReported = new Promise<void>((resolve) => {
      reportTerminated = resolve
    })
    const pending = runProcess({
      program: join(dir, 'hung.cmd'),
      timeoutMs: null,
      signal: controller.signal,
      terminationBarrier: true,
      onChildTerminated: () => reportTerminated()
    })
    const grandchild = await waitForGrandchildPid()
    expect(isAlive(grandchild)).toBe(true)

    const abortedAt = Date.now()
    controller.abort()
    await pending
    const settledAfterMs = Date.now() - abortedAt
    await terminationReported
    const reportedAfterMs = Date.now() - abortedAt
    console.log(
      `[late-taskkill] caller settled ${settledAfterMs} ms, termination reported ${reportedAfterMs} ms after abort`
    )
    // TerminateProcess returns before the pid is fully released, so allow a short drain.
    const goneBy = Date.now() + 5_000
    while (isAlive(grandchild) && Date.now() < goneBy) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(isAlive(grandchild)).toBe(false)
  }
})
