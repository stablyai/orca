import { copyFileSync, renameSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

// Windows AV/CLI file handles transiently cause EPERM/EACCES/EBUSY during replacement. Bound retries (~750ms) cover typical scans without hiding persistent permission errors (#1507).
const DEFAULT_MAX_ATTEMPTS = 6
export function renameFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => renameSync(source, target))
}

/** `maxAttempts` raises the budget (attempt n waits n × 50 ms), e.g. for a just-killed process tree. */
export async function renameFileWithWindowsRetryAsync(
  source: string,
  target: string,
  isCurrent: () => boolean = () => true,
  maxAttempts = DEFAULT_MAX_ATTEMPTS
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (!isCurrent()) {
      return false
    }
    try {
      await rename(source, target)
      return true
    } catch (error) {
      if (!shouldRetryFileOperation(error, attempt, maxAttempts)) {
        throw error
      }
      await setTimeout(attempt * 50)
    }
  }
}

export function copyFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => copyFileSync(source, target))
}

function runFileOperationWithWindowsRetry(operation: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      operation()
      return
    } catch (error) {
      if (shouldRetryFileOperation(error, attempt, DEFAULT_MAX_ATTEMPTS)) {
        sleepSync(attempt * 50)
        continue
      }
      throw error
    }
  }
}

function shouldRetryFileOperation(error: unknown, attempt: number, maxAttempts: number): boolean {
  return (
    process.platform === 'win32' &&
    attempt < maxAttempts &&
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
