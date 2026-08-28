import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'

const PROBE_INTERVAL_MS = 25
const SUBPROCESS_TIMEOUT_MS = 2_000
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Signal the child's whole tree.
 *
 * POSIX precondition: the child must have been spawned `detached`. The signal
 * goes to the process group `-child.pid`, so a child that is not its own group
 * leader would hand it to whatever group it inherited instead.
 */
export function signalProcessTree(child: ChildProcess, signal?: NodeJS.Signals): Promise<boolean> {
  if (!child.pid) {
    killRoot(child, signal)
    return Promise.resolve(true)
  }
  if (process.platform === 'win32') {
    return taskkillTree(child, signal)
  }
  try {
    process.kill(-child.pid, signal)
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(!processGroupExists(child.pid))
  }
}

export async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
  const root = child.pid
  const posix = process.platform !== 'win32' && Boolean(root)
  // Snapshot descendants BEFORE signalling. A gate child that calls setsid()
  // leaves the process group, so `kill(-pgid)` never reaches it and group-only
  // quiescence would report containment while it still holds the worktree.
  const escapees = posix && root ? await readDescendantPids(root) : []
  const signaled = await signalProcessTree(child, 'SIGKILL')
  if (!signaled) {
    return false
  }
  if (!posix || !root) {
    return true
  }
  for (const pid of escapees) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  return waitForPosixProcessGroupQuiescence(root, escapees)
}

/** Every descendant of `root` by parent chain, root excluded. Empty when `ps`
 *  cannot be read — the caller still signals the group, and quiescence then
 *  falls back to what it can actually prove. */
async function readDescendantPids(root: number): Promise<number[]> {
  const output = await capturePs(['-axo', 'pid=,ppid='])
  if (output === null) {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)/)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const ppid = Number(match[2])
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const found: number[] = []
  const queue = [root]
  const seen = new Set([root])
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift() as number) ?? []) {
      if (seen.has(pid)) {
        continue
      }
      seen.add(pid)
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
}

function taskkillTree(child: ChildProcess, signal?: NodeJS.Signals): Promise<boolean> {
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      })
    } catch {
      killRoot(child, signal)
      resolve(false)
      return
    }
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

async function waitForPosixProcessGroupQuiescence(
  processGroupId: number,
  escapees: readonly number[] = []
): Promise<boolean> {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId, escapees)
    if (
      states
        ? states.every((state) => state.startsWith('Z'))
        : !processGroupExists(processGroupId) && escapees.every((pid) => !processExists(pid))
    ) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
}

/** States of every process still in the group OR still one of the snapshotted
 *  escapees. Null when `ps` could not be read. */
async function readPosixProcessGroupStates(
  processGroupId: number,
  escapees: readonly number[]
): Promise<string[] | null> {
  const output = await capturePs(['-axo', 'pid=,pgid=,state='])
  if (output === null) {
    return null
  }
  const escaped = new Set(escapees)
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/)
    if (!match) {
      return []
    }
    return Number(match[2]) === processGroupId || escaped.has(Number(match[1])) ? [match[3]] : []
  })
}

function capturePs(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let probe: ChildProcess
    try {
      probe = nodeSpawn('ps', [...args], {
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
    const finish = (value: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
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
    probe.once('close', (code) => finish(code !== 0 || truncated ? null : output))
    const timer = setTimeout(() => {
      probe.kill()
      finish(null)
    }, SUBPROCESS_TIMEOUT_MS)
    timer.unref?.()
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
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
