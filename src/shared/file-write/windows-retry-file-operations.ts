import { copyFileSync, renameSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

// Windows AV/CLI file handles transiently cause EPERM/EACCES/EBUSY during replacement. Bound retries (~750ms by default) cover typical scans without hiding persistent permission errors (#1507).
const DEFAULT_ATTEMPTS = 6

export function renameFileWithWindowsRetry(
  source: string,
  target: string,
  isCurrent: () => boolean = () => true
): boolean {
  for (let attempt = 1; ; attempt++) {
    if (!isCurrent()) {
      return false
    }
    try {
      renameSync(source, target)
      return true
    } catch (error) {
      if (!shouldRetryFileOperation(error, attempt)) {
        throw error
      }
      sleepSync(attempt * 50)
    }
  }
}

export async function renameFileWithWindowsRetryAsync(
  source: string,
  target: string,
  isCurrent: () => boolean = () => true,
  { attempts = DEFAULT_ATTEMPTS, signal }: { attempts?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    if (!isCurrent()) {
      return false
    }
    try {
      await rename(source, target)
      return true
    } catch (error) {
      if (!shouldRetryFileOperation(error, attempt, attempts)) {
        throw error
      }
      await setTimeout(attempt * 50, undefined, { signal })
    }
  }
}

export function copyFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => copyFileSync(source, target))
}

/** Missing files are fine; Windows AV locks on a just-written file are retried with backoff. */
export function removeFileWithWindowsRetry(path: string): void {
  runFileOperationWithWindowsRetry(() => rmSync(path, { force: true }))
}

function runFileOperationWithWindowsRetry(operation: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      operation()
      return
    } catch (error) {
      if (shouldRetryFileOperation(error, attempt)) {
        sleepSync(attempt * 50)
        continue
      }
      throw error
    }
  }
}

function shouldRetryFileOperation(
  error: unknown,
  attempt: number,
  attempts = DEFAULT_ATTEMPTS
): boolean {
  return (
    process.platform === 'win32' &&
    attempt < attempts &&
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
  )
}

// Sync atomic-write callers require blocking backoff; park the thread instead of busy-spinning.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}
