import { spawn, type ChildProcess } from 'node:child_process'

export const PROCESS_TREE_FORCE_KILL_DELAY_MS = 2_000
const WINDOWS_TASKKILL_ATTEMPT_TIMEOUT_MS = 1_000
const WINDOWS_TASKKILL_MAX_ATTEMPTS = 2

export type SpawnedProcessTreeCleanupResult = Readonly<{
  cleanupError?: Error
  disposition: 'tree-killed' | 'root-killed' | 'stale-root'
}>

type CleanupOptions = {
  deadlineMs?: number
  killPosixProcessGroup?: boolean
  platform?: NodeJS.Platform
  processKill?: typeof process.kill
  spawnImpl?: typeof spawn
}

function cleanupRemainingMs(deadlineMs: number | undefined, fallbackMs: number): number {
  return deadlineMs === undefined
    ? fallbackMs
    : Math.max(0, Math.min(fallbackMs, Math.floor(deadlineMs - performance.now())))
}

function hasLiveSpawnedIncarnation(child: ChildProcess): boolean {
  if (
    !child.pid ||
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  ) {
    return false
  }
  try {
    // Why: libuv targets the retained process handle, so signal 0 proves the
    // original child still owns this PID; a recycled PID never earns taskkill.
    return child.kill(0)
  } catch {
    return false
  }
}

function taskkillAttempt(
  pid: number,
  spawnImpl: typeof spawn,
  timeoutMs: number
): Promise<Error | null> {
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      killer = spawnImpl('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      if (!killer || typeof killer.once !== 'function') {
        resolve(new Error('taskkill did not start.'))
        return
      }
    } catch (error) {
      resolve(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      killer.removeAllListeners()
      resolve(error)
    }
    killer.once('error', (error) => finish(error))
    killer.once('close', (code) =>
      finish(code === 0 ? null : new Error(`taskkill exited with ${code ?? 'unknown'}.`))
    )
    const timer = setTimeout(() => {
      killer.kill()
      finish(new Error('taskkill timed out.'))
    }, timeoutMs)
    timer.unref?.()
    killer.unref?.()
  })
}

async function cleanupWindowsTree(
  child: ChildProcess,
  spawnImpl: typeof spawn,
  deadlineMs?: number
): Promise<SpawnedProcessTreeCleanupResult> {
  const pid = child.pid
  if (!pid || !hasLiveSpawnedIncarnation(child)) {
    return { disposition: 'stale-root' }
  }
  let cleanupError: Error | null = null
  for (let attempt = 0; attempt < WINDOWS_TASKKILL_MAX_ATTEMPTS; attempt += 1) {
    if (!hasLiveSpawnedIncarnation(child)) {
      return cleanupError
        ? { disposition: 'stale-root', cleanupError }
        : { disposition: 'stale-root' }
    }
    const remainingMs = cleanupRemainingMs(deadlineMs, WINDOWS_TASKKILL_ATTEMPT_TIMEOUT_MS)
    if (remainingMs <= 0) {
      cleanupError = new Error('process tree cleanup deadline expired.')
      break
    }
    const remainingAttempts = WINDOWS_TASKKILL_MAX_ATTEMPTS - attempt
    cleanupError = await taskkillAttempt(
      pid,
      spawnImpl,
      Math.max(1, Math.min(WINDOWS_TASKKILL_ATTEMPT_TIMEOUT_MS, remainingMs / remainingAttempts))
    )
    if (!cleanupError) {
      return { disposition: 'tree-killed' }
    }
  }
  if (hasLiveSpawnedIncarnation(child)) {
    child.kill()
    return { disposition: 'root-killed', cleanupError: cleanupError ?? undefined }
  }
  return { disposition: 'stale-root', cleanupError: cleanupError ?? undefined }
}

async function cleanupPosixTree(
  child: ChildProcess,
  killGroup: boolean,
  processKill: typeof process.kill,
  deadlineMs?: number
): Promise<SpawnedProcessTreeCleanupResult> {
  const pid = child.pid
  if (!pid || !killGroup) {
    child.kill()
    return { disposition: 'root-killed' }
  }
  try {
    processKill(-pid, 'SIGTERM')
  } catch {
    child.kill()
    return { disposition: 'root-killed' }
  }
  const forceKillDelayMs = cleanupRemainingMs(deadlineMs, PROCESS_TREE_FORCE_KILL_DELAY_MS)
  if (forceKillDelayMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, forceKillDelayMs)
      timer.unref?.()
    })
  }
  try {
    processKill(-pid, 'SIGKILL')
  } catch {
    /* process group already exited */
  }
  return { disposition: 'tree-killed' }
}

/** Cleanup settles only after escalation, and Windows tree kills require the
 * retained child handle to prove the PID still belongs to that incarnation. */
export function cleanupSpawnedProcessTree(
  child: ChildProcess,
  options: CleanupOptions = {}
): Promise<SpawnedProcessTreeCleanupResult> {
  return (options.platform ?? process.platform) === 'win32'
    ? cleanupWindowsTree(child, options.spawnImpl ?? spawn, options.deadlineMs)
    : cleanupPosixTree(
        child,
        options.killPosixProcessGroup ?? false,
        options.processKill ?? process.kill.bind(process),
        options.deadlineMs
      )
}

export function preserveProcessCleanupFailure(
  primaryError: Error,
  result: SpawnedProcessTreeCleanupResult
): Error {
  if (result.cleanupError) {
    Object.assign(primaryError, { cleanupError: result.cleanupError })
  }
  return primaryError
}
