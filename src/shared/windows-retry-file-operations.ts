import { copyFileSync, renameSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

// Why: on Windows, file replacement and backup-copy operations can fail with
// EPERM/EACCES/EBUSY if another process (antivirus, Claude CLI, Codex CLI)
// holds the target file open. A short retry avoids transient failures without
// masking real permission errors. Total backoff (~750ms) covers typical AV
// scan windows seen in issue #1507.
export function renameFileWithWindowsRetry(source: string, target: string): void {
  runFileOperationWithWindowsRetry(() => renameSync(source, target))
}

export async function renameFileWithWindowsRetryAsync(
  source: string,
  target: string,
  isCurrent: () => boolean = () => true
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    if (!isCurrent()) {
      return false
    }
    try {
      await rename(source, target)
      return true
    } catch (error) {
      if (!shouldRetryFileOperation(error, attempt)) {
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
      if (shouldRetryFileOperation(error, attempt)) {
        sleepSync(attempt * 50)
        continue
      }
      throw error
    }
  }
}

function shouldRetryFileOperation(error: unknown, attempt: number): boolean {
  return (
    process.platform === 'win32' &&
    attempt < 6 &&
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
  )
}

// Why: writeFileAtomically is a sync API called from sync paths, so the retry
// backoff must park the thread instead of burning CPU in a Date.now() loop.
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}
