import { spawn, type ChildProcess } from 'node:child_process'
import { win32 as win32Path } from 'node:path'

const childrenWithTerminationSink = new WeakSet<ChildProcess>()
const childrenWithWslTreeTermination = new WeakSet<ChildProcess>()
export const WSL_TREE_KILL_TIMEOUT_MS = 2_000

function retainTerminationErrorSink(child: ChildProcess): void {
  if (childrenWithTerminationSink.has(child)) {
    return
  }
  childrenWithTerminationSink.add(child)

  const release = (): void => {
    childrenWithTerminationSink.delete(child)
    child.off('error', onError)
    child.off('close', release)
  }
  const onError = (): void => release()

  child.once('error', onError)
  child.once('close', release)
}

export function terminateSpawnedChild(child: ChildProcess): void {
  if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
    // Why: a failed spawn reports ENOENT after cancellation cleanup; retain one
    // sink for it, and never let kill(undefined) signal this process.
    retainTerminationErrorSink(child)
    return
  }

  if (
    process.platform === 'win32' &&
    typeof child.spawnfile === 'string' &&
    win32Path.basename(child.spawnfile).toLowerCase() === 'wsl.exe'
  ) {
    terminateWslProcessTree(child)
    return
  }
  terminateDirectChild(child)
}

function terminateDirectChild(child: ChildProcess): void {
  if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
    retainTerminationErrorSink(child)
    return
  }
  try {
    child.kill()
  } catch {
    // Cancellation is best-effort; the child may have exited between checks.
  }
}

function terminateWslProcessTree(child: ChildProcess): void {
  if (childrenWithWslTreeTermination.has(child)) {
    return
  }
  childrenWithWslTreeTermination.add(child)

  let killer: ChildProcess
  try {
    // Why: killing wsl.exe alone can orphan its Linux command; /T terminates the wrapper tree.
    killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    terminateDirectChild(child)
    return
  }

  let settled = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const finish = (fallbackToDirectKill: boolean): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    killer.off('error', onError)
    killer.off('close', onClose)
    if (fallbackToDirectKill) {
      terminateDirectChild(child)
    }
  }
  const onError = (): void => finish(true)
  const onClose = (code: number | null): void => finish(code !== 0)

  killer.once('error', onError)
  killer.once('close', onClose)
  timeout = setTimeout(() => {
    terminateDirectChild(killer)
    finish(true)
  }, WSL_TREE_KILL_TIMEOUT_MS)
  timeout.unref?.()
  killer.unref?.()
}
