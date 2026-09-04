import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { notifyProcessTreeKill } from './process-tree-kill-observer'

const PROBE_INTERVAL_MS = 25
const SUBPROCESS_TIMEOUT_MS = 2_000
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Signal the child's whole tree.
 *
 * POSIX precondition: the child must have been spawned `detached`. The signal
 * goes to the process group `-child.pid`, so a child that is not its own group
 * leader would hand it to whatever group it inherited instead.
 *
 * Runs in every host — Electron main, the daemon, the relay, the CLI — so the
 * main-process own-Chromium guard cannot reach here; the exit check below is
 * what keeps the Windows branch off a pid that is no longer ours.
 */
export function signalProcessTree(child: ChildProcess, signal?: NodeJS.Signals): Promise<boolean> {
  if (!child.pid) {
    killRoot(child, signal)
    return Promise.resolve(true)
  }
  if (process.platform === 'win32') {
    // Why the exit check: once the child is reaped its pid is Windows' to
    // reissue, and `taskkill /t /f` walks whatever tree owns it *now* — a
    // recycled pid can be one of Orca's own Chromium processes (#10680). The
    // POSIX branch below cannot hit this: killing a reaped group is ESRCH.
    //
    // Why `false`: this is exactly what a taskkill against a reaped pid already
    // resolved to (non-zero exit -> killRoot + `false`), so skipping the unsafe
    // spawn must not also flip the termination barrier to "verified". Reporting
    // `true` here would release the git admission grant on root exit instead of
    // on `close`, admitting the next git command while a descendant that
    // inherited the pipes still holds the repo.
    if (hasExited(child)) {
      killRoot(child, signal)
      return Promise.resolve(false)
    }
    return taskkillTree(child, child.pid, signal)
  }
  try {
    process.kill(-child.pid, signal)
    notifyProcessTreeKill({
      pid: child.pid,
      site: 'run-process-tree',
      scope: 'posix-process-group'
    })
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(!processGroupExists(child.pid))
  }
}

export async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
  const signaled = await signalProcessTree(child, 'SIGKILL')
  if (!signaled) {
    return false
  }
  if (process.platform !== 'win32' && child.pid) {
    return waitForPosixProcessGroupQuiescence(child.pid)
  }
  return true
}

/** A stubbed child leaves both undefined; only a real code or signal proves exit. */
function hasExited(child: ChildProcess): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

function taskkillTree(
  child: ChildProcess,
  rootPid: number,
  signal?: NodeJS.Signals
): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = nodeSpawn('taskkill', ['/pid', String(rootPid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      })
    } catch {
      killRoot(child, signal)
      resolve(false)
      return
    }
    notifyProcessTreeKill({ pid: rootPid, site: 'run-process-tree', scope: 'win-taskkill-tree' })
    let settled = false
    const finish = (fallback: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (fallback) {
        killRoot(child, signal)
      }
      resolve(!fallback)
    }
    killer.once('error', () => finish(true))
    killer.once('close', (code) => finish(code !== 0))
    const timer = setTimeout(() => {
      killer.kill()
      finish(true)
    }, SUBPROCESS_TIMEOUT_MS)
    timer.unref?.()
  })
}

async function waitForPosixProcessGroupQuiescence(processGroupId: number): Promise<boolean> {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId)
    if (
      states ? states.every((state) => state.startsWith('Z')) : !processGroupExists(processGroupId)
    ) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
}

function readPosixProcessGroupStates(processGroupId: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    let probe: ChildProcess
    try {
      probe = nodeSpawn('ps', ['-axo', 'pgid=,state='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    let truncated = false
    let settled = false
    const finish = (states: string[] | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(states)
    }
    probe.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
        truncated = true
        return
      }
      output += text
    })
    probe.stdout?.on('error', () => {})
    probe.once('error', () => finish(null))
    probe.once('close', (code) => {
      if (code !== 0 || truncated) {
        finish(null)
        return
      }
      const states = output.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/)
        return match && Number(match[1]) === processGroupId ? [match[2]] : []
      })
      finish(states)
    })
    const timer = setTimeout(() => {
      probe.kill()
      finish(null)
    }, SUBPROCESS_TIMEOUT_MS)
    timer.unref?.()
  })
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function killRoot(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
