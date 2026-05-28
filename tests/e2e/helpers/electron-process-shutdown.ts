import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
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

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
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

  // Why: CI showed orphaned Electron renderer and shell children after the
  // parent close path returned. Capture the tree before killing the root so
  // descendants do not get reparented out from under the cleanup.
  const pids = [...readPosixDescendantPids(pid), pid]
  for (const targetPid of [...pids].reverse()) {
    killPid(targetPid, 'SIGTERM')
  }
  await delay(FORCE_KILL_WAIT_MS)
  for (const targetPid of [...pids].reverse()) {
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

export async function closeElectronAppForE2E(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  try {
    await withTimeout(app.close(), GRACEFUL_CLOSE_TIMEOUT_MS, 'Timed out closing Electron app')
    if (proc) {
      const exited = await waitForExit(proc, PROCESS_EXIT_TIMEOUT_MS)
      if (!exited) {
        await forceKillProcessTree(proc)
      }
    }
  } catch {
    if (proc) {
      await forceKillProcessTree(proc)
    }
  }
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
    try {
      const raw = readFileSync(path.join(daemonDir, entry), 'utf8').trim()
      const parsed = JSON.parse(raw) as { pid?: unknown }
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pids.push(parsed.pid)
      }
    } catch {
      const pid = Number(readFileSync(path.join(daemonDir, entry), 'utf8').trim())
      if (Number.isInteger(pid)) {
        pids.push(pid)
      }
    }
  }
  return pids
}

export async function cleanupE2EDaemons(userDataDir: string): Promise<void> {
  // Why: app quit intentionally leaves daemon PTYs alive for warm reattach.
  // E2E temp profiles are deleted after each test, so their detached daemons
  // must be stopped explicitly or CI accumulates orphan Electron/shell trees.
  for (const pid of readDaemonPidFiles(userDataDir)) {
    await forceKillPidTree(pid)
  }
}
