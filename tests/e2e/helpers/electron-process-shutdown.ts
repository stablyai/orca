import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { cleanupE2ECrashpad } from './electron-crashpad-cleanup'
import { recordElectronShutdownTiming } from './electron-shutdown-timing'
import type { ElectronApplication } from '@stablyai/playwright-test'

const GRACEFUL_CLOSE_TIMEOUT_MS = 10_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const FORCE_KILL_WAIT_MS = 2_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    timeout.unref?.()
  })
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function releaseExitedProcessPipes(proc: ChildProcess): void {
  if (!hasExited(proc)) {
    return
  }
  // Detached SSH helpers can retain inherited pipes after Electron itself exits.
  for (const stream of proc.stdio) {
    stream?.destroy()
  }
}

export function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      proc.off('exit', onExit)
      proc.off('close', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    timeout.unref?.()
    proc.once('exit', onExit)
    proc.once('close', onExit)
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function readPosixDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    const childrenByParent = new Map<number, number[]>()
    for (const line of output.split('\n')) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        continue
      }
      const children = childrenByParent.get(ppid) ?? []
      children.push(pid)
      childrenByParent.set(ppid, children)
    }

    const descendants: number[] = []
    const stack = [...(childrenByParent.get(rootPid) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()
      if (!pid) {
        continue
      }
      descendants.push(pid)
      stack.push(...(childrenByParent.get(pid) ?? []))
    }
    return descendants
  } catch {
    return []
  }
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already dead or inaccessible */
  }
}

function hasPidExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

async function forceKillPidTree(pid: number): Promise<void> {
  if (!pid) {
    return
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already dead or taskkill unavailable */
    }
    return
  }

  // Capture descendants before killing the root or reparenting can strand Electron/shell children.
  const pids = [...readPosixDescendantPids(pid), pid]
  for (const targetPid of [...pids].toReversed()) {
    killPid(targetPid, 'SIGTERM')
  }
  const deadline = performance.now() + FORCE_KILL_WAIT_MS
  while (true) {
    if (pids.every(hasPidExited)) {
      return
    }
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) {
      break
    }
    await delay(Math.min(50, remainingMs))
  }
  for (const targetPid of [...pids].toReversed()) {
    killPid(targetPid, 'SIGKILL')
  }
}

async function forceKillProcessTree(proc: ChildProcess): Promise<void> {
  const pid = proc.pid
  if (!pid || hasExited(proc)) {
    return
  }

  await forceKillPidTree(pid)
  await waitForExit(proc, PROCESS_EXIT_TIMEOUT_MS)
}

// SIGKILL the whole tree without shutdown hooks for force-quit scenarios; use ordinary close for graceful persistence.
export async function forceQuitElectronAppForE2E(
  app: ElectronApplication,
  options: { preserveDaemons?: boolean } = {}
): Promise<void> {
  const proc = app.process()
  const pid = proc.pid
  if (pid) {
    if (options.preserveDaemons) {
      // Chromium helpers hold Windows profile handles; Electron's list excludes detached daemons.
      const appPids = await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid }) => pid))
      for (const targetPid of new Set([pid, ...appPids])) {
        killPid(targetPid, 'SIGKILL')
      }
    } else if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore'
        })
      } catch {
        /* already dead or taskkill unavailable */
      }
    } else {
      // Capture the tree before the root dies, so descendants cannot be reparented out of reach.
      for (const targetPid of [...readPosixDescendantPids(pid), pid].toReversed()) {
        killPid(targetPid, 'SIGKILL')
      }
    }
  }
  await waitForExit(proc, PROCESS_EXIT_TIMEOUT_MS)
  releaseExitedProcessPipes(proc)
  // Playwright close can remain pending after an external force-kill.
  await withTimeout(
    app.close(),
    PROCESS_EXIT_TIMEOUT_MS,
    'Timed out releasing killed Electron app'
  ).catch(() => undefined)
}

// Stop serve like a supervisor so its detached PTYs survive; macOS vetoes unmarked app.quit and ordinary close may kill the daemon (#15537).
export async function stopServeElectronAppForE2E(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  // Why: Windows has no catchable SIGTERM, and its serve has no native-quit veto to bypass.
  if (process.platform === 'win32' || !proc.pid) {
    await closeElectronAppForE2E(app)
    return
  }
  if (!hasExited(proc)) {
    proc.kill('SIGTERM')
  }
  if (!(await waitForExit(proc, GRACEFUL_CLOSE_TIMEOUT_MS))) {
    throw new Error(`orca serve ${proc.pid} did not exit after SIGTERM`)
  }
  releaseExitedProcessPipes(proc)
  // Playwright close can remain pending after the process exits on its own.
  await withTimeout(
    app.close(),
    PROCESS_EXIT_TIMEOUT_MS,
    'Timed out releasing stopped serve process'
  ).catch(() => undefined)
}

export async function closeElectronAppForE2E(
  app: ElectronApplication,
  options: { cleanupDaemonsForUserDataDir?: string } = {}
): Promise<void> {
  const proc = app.process()
  const started = performance.now()
  let rootExitMs: number | null = hasExited(proc) ? 0 : null
  let pipesClosedMs: number | null = null
  let outcome = 'closed'
  let daemonCleanup: Promise<void> | undefined
  const startDaemonCleanup = (): void => {
    if (options.cleanupDaemonsForUserDataDir && !daemonCleanup) {
      daemonCleanup = cleanupE2EDaemons(options.cleanupDaemonsForUserDataDir)
      void daemonCleanup.catch(() => undefined)
    }
  }
  const releasePipes = (): void => {
    if (hasExited(proc)) {
      rootExitMs ??= performance.now() - started
      // Linux daemon trees retain Chromium sockets that block Playwright's public close.
      startDaemonCleanup()
    }
    releaseExitedProcessPipes(proc)
  }
  const pipesClosed = (): void => {
    pipesClosedMs = performance.now() - started
  }
  proc.once('exit', releasePipes)
  proc.once('close', pipesClosed)
  releasePipes()
  try {
    await withTimeout(app.close(), GRACEFUL_CLOSE_TIMEOUT_MS, 'Timed out closing Electron app')
    if (proc) {
      const exited = await waitForExit(proc, PROCESS_EXIT_TIMEOUT_MS)
      if (!exited) {
        await forceKillProcessTree(proc)
      }
    }
  } catch {
    outcome = 'fallback'
    if (proc) {
      await forceKillProcessTree(proc)
    }
  } finally {
    proc.off('exit', releasePipes)
    proc.off('close', pipesClosed)
    releasePipes()
    recordElectronShutdownTiming('close', started, {
      pid: proc.pid,
      outcome,
      rootExitMs,
      pipesClosedMs
    })
  }
  startDaemonCleanup()
  await daemonCleanup
}

function readDaemonPidFiles(userDataDir: string): number[] {
  const daemonDir = path.join(userDataDir, 'daemon')
  if (!existsSync(daemonDir)) {
    return []
  }

  const pids: number[] = []
  for (const entry of readdirSync(daemonDir)) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    let raw: string
    try {
      raw = readFileSync(path.join(daemonDir, entry), 'utf8').trim()
    } catch {
      // Why: an exiting daemon removes its pid file between readdir and read.
      continue
    }
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pids.push(parsed.pid)
      }
    } catch {
      const pid = Number(raw)
      if (Number.isInteger(pid)) {
        pids.push(pid)
      }
    }
  }
  return pids
}

export async function cleanupE2EDaemons(userDataDir: string): Promise<void> {
  // Ordinary quit retains daemon PTYs; disposable profiles must explicitly stop them to avoid leaked CI process trees.
  const started = performance.now()
  const pids = readDaemonPidFiles(userDataDir)
  try {
    for (const pid of pids) {
      await forceKillPidTree(pid)
    }
    cleanupE2ECrashpad(userDataDir)
  } finally {
    recordElectronShutdownTiming('daemon-cleanup', started, { daemonCount: pids.length })
  }
}
