// Why: Windows releases handles late. Antivirus, the search indexer, a just-exited child and a
// freshly dlopen'd DLL all keep a tree Node has just emptied locked for a few milliseconds, which
// surfaces as EBUSY/ENOTEMPTY/EPERM. Node's own `maxRetries` absorbs exactly that, and the repo
// already settled on 8 attempts — but only product code was using it, so test teardown kept
// failing tests whose assertions had already passed.

import type { RmOptions } from 'node:fs'
import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export const WINDOWS_RM_MAX_RETRIES = 8
export const WINDOWS_RM_RETRY_DELAY_MS = 150

/** `rm`/`rmSync` options for a recursive removal that must survive a late handle release. */
export function transientLockRemovalOptions(): RmOptions {
  const base = { recursive: true, force: true }
  if (process.platform !== 'win32') {
    return base
  }
  return { ...base, maxRetries: WINDOWS_RM_MAX_RETRIES, retryDelay: WINDOWS_RM_RETRY_DELAY_MS }
}

function isTransientWindowsLockError(error: unknown): boolean {
  if (process.platform !== 'win32' || typeof error !== 'object' || error === null) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code)) {
    return true
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /directory not empty|resource busy|operation not permitted/i.test(message)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Recursively remove a directory, retrying the transient Windows locks. */
export function removeTreeSync(targetPath: string): void {
  const options = transientLockRemovalOptions()
  const extraAttempts = process.platform === 'win32' ? WINDOWS_RM_MAX_RETRIES : 0
  let attempt = 0
  for (;;) {
    try {
      rmSync(targetPath, options)
      return
    } catch (error) {
      // Why the outer loop: Node's `maxRetries` only runs inside a real `rmSync`. A mock, or a
      // handle that outlives those inner attempts, still surfaces EPERM. `force: true` only
      // suppresses ENOENT.
      if (attempt >= extraAttempts || !isTransientWindowsLockError(error)) {
        throw error
      }
      sleepSync(WINDOWS_RM_RETRY_DELAY_MS)
      attempt += 1
    }
  }
}

/** Recursively remove a directory, retrying the transient Windows locks. */
export async function removeTree(targetPath: string): Promise<void> {
  await rm(targetPath, transientLockRemovalOptions())
}
