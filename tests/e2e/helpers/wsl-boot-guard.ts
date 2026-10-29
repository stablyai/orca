/**
 * Shared by the E9 real-WSL guards: wsl.exe reads that can never start a distro, a running-list
 * watcher with a timestamped timeline, and the spawn-log check that names what started it.
 */
import { execFile } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { buildWslExecArgs } from '../../../src/shared/wsl-login-shell-command'
import { readDiagnosticLog, UNC_TOUCH, type DiagnosticRecord } from './wsl-boot-diagnostics-log'

const WSL_EXE = /(^|[\\/])wsl(\.exe)?$/i

/** Async with a timeout: a hung wsl.exe must fail the test, never block the worker past its timeout. */
export function wsl(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      [...args],
      // UTF-8 instead of wsl.exe's default UTF-16 for its own listings.
      {
        encoding: 'utf8',
        env: { ...process.env, WSL_UTF8: '1' },
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`wsl ${args.join(' ')} failed: ${String(error)} ${stderr}`))
          : resolve(stdout)
    )
  })
}

/** Timestamped steps in the test output, so a lane failure shows when each read and act happened. */
const startedAt = Date.now()
export function timeline(event: string, at = Date.now()): void {
  console.log(`[e9-guard +${Math.round(at - startedAt)}ms] ${event}`)
}

/**
 * `--list --running` never starts a distro. Exit 1 is "no running distributions"; any other
 * failure (timeout, spawn error, other exit) rejects, so it can never read as "stopped".
 */
export function isDistroRunning(distro: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['--list', '--running', '--quiet'],
      {
        encoding: 'utf8',
        env: { ...process.env, WSL_UTF8: '1' },
        timeout: 5_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          if (error.code === 1 && !error.killed) {
            resolve(false)
          } else {
            reject(error)
          }
          return
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.replaceAll('\0', '').trim().toLowerCase())
            .includes(distro.toLowerCase())
        )
      }
    )
  })
}

/** How long a just-terminated instance may still be listed: two reads, each up to 5 s on a loaded runner. */
const TERMINATE_GRACE_MS = 10_000

/**
 * Polls the running list once a second, never overlapping, from right after `--terminate`.
 * `stopped` resolves on the first not-running read, which must come within the grace; only
 * running reads before it are forgiven, so a real boot is never waited out. Any running read
 * after it is a boot. Three failed reads in a row fail the guard.
 */
export function watchDistroRunning(
  distro: string,
  spawnLog: string
): {
  stopped: Promise<void>
  stop: () => Promise<{ seenRunning: boolean; reads: number }>
} {
  let finished = false
  let confirmedStopped = false
  let seenRunning = false
  let reads = 0
  let failures = 0
  let failure: unknown = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<void> = Promise.resolve()
  let resolveStopped: () => void = () => {}
  let rejectStopped: (error: Error) => void = () => {}
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve
    rejectStopped = reject
  })
  const grace = setTimeout(
    () =>
      rejectStopped(
        new Error(`${distro} was still listed ${TERMINATE_GRACE_MS} ms after --terminate`)
      ),
    TERMINATE_GRACE_MS
  )
  // Spawns are interleaved into the timeline so a boot can be matched to the launch before it.
  let spawnsSeen = readDiagnosticLog(spawnLog).length
  const logNewWslSpawns = (): void => {
    const spawns = readDiagnosticLog(spawnLog)
    for (const spawn of spawns.slice(spawnsSeen)) {
      if (WSL_EXE.test(spawn.file) || spawn.file === UNC_TOUCH) {
        // `at` is when it happened; the line prints at this poll, up to a second later.
        timeline(
          `${spawn.file === UNC_TOUCH ? 'unc' : 'spawn'} ${spawn.file} ${spawn.args.join(' ')}`,
          spawn.at
        )
        if (startsDistro(spawn, distro) || spawn.file === UNC_TOUCH) {
          for (const frame of spawn.stack ?? []) {
            timeline(`    ${frame}`, spawn.at)
          }
        }
      }
    }
    spawnsSeen = spawns.length
  }
  const tick = (): void => {
    logNewWslSpawns()
    current = isDistroRunning(distro)
      .then((running) => {
        reads += 1
        failures = 0
        timeline(`running list: ${distro} ${running ? 'RUNNING' : 'stopped'}`)
        if (confirmedStopped) {
          seenRunning ||= running
        } else if (!running) {
          confirmedStopped = true
          clearTimeout(grace)
          resolveStopped()
        }
      })
      .catch((error: unknown) => {
        failures += 1
        timeline(`running-list read failed: ${String(error)}`)
        if (failures >= 3) {
          failure = error
          rejectStopped(new Error(`wsl --list --running kept failing: ${String(error)}`))
        }
      })
      .finally(() => {
        if (!finished && failure === null) {
          timer = setTimeout(tick, 1_000)
        }
      })
  }
  tick()
  return {
    stopped,
    stop: async () => {
      finished = true
      clearTimeout(timer)
      clearTimeout(grace)
      await current
      logNewWslSpawns()
      if (failure !== null) {
        throw new Error(`wsl --list --running kept failing: ${String(failure)}`)
      }
      return { seenRunning, reads }
    }
  }
}

export function runInDistro(distro: string, script: string): Promise<string> {
  return wsl(['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])])
}

/** wsl.exe verbs that never start a distro; any other launch counts as starting the default one. */
const NON_BOOTING_WSL_VERBS = new Set([
  '-l',
  '--list',
  '--status',
  '--version',
  '-v',
  '-t',
  '--terminate',
  '--shutdown',
  '--help'
])

/** Fails closed: a wsl.exe launch starts `distro` unless it names another one or only lists. */
export function startsDistro(spawn: DiagnosticRecord, distro: string): boolean {
  if (!WSL_EXE.test(spawn.file)) {
    return false
  }
  // main's ChildProcess#spawn args carry argv0; process-host's do not.
  const raw = WSL_EXE.test(spawn.args[0] ?? '') ? spawn.args.slice(1) : spawn.args
  const args = raw.map((arg) => arg.toLowerCase())
  const named = args.findIndex((arg) => arg === '-d' || arg === '--distribution')
  if (named !== -1) {
    return args[named + 1] === distro.toLowerCase()
  }
  return !NON_BOOTING_WSL_VERBS.has(args[0] ?? '')
}

/** Waits until no wsl.exe launch has been logged for 3 s, so a user act's tail is over. */
export async function waitForWslLaunchesToSettle(spawnLog: string): Promise<void> {
  let last = { count: -1, since: 0 }
  await expect
    .poll(
      () => {
        const count = readDiagnosticLog(spawnLog).filter((spawn) => WSL_EXE.test(spawn.file)).length
        const now = performance.now()
        if (count !== last.count) {
          last = { count, since: now }
        }
        return now - last.since >= 3_000
      },
      { timeout: 60_000, intervals: [500] }
    )
    .toBe(true)
}

export async function cycleWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  })
}

export async function activate(page: Page, worktreeId: string | null): Promise<void> {
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
}
