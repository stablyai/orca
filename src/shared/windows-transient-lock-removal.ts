// Windows handles from AV/indexers/children/DLLs can briefly outlive deletion. Share bounded EBUSY/ENOTEMPTY/EPERM retries with teardown so passing tests do not fail during cleanup.

import type { RmOptions } from 'node:fs'
import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export const WINDOWS_RM_MAX_RETRIES = 8
export const WINDOWS_RM_RETRY_DELAY_MS = 150

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

export function removeTreeSync(targetPath: string): void {
  const options = transientLockRemovalOptions()
  const extraAttempts = process.platform === 'win32' ? WINDOWS_RM_MAX_RETRIES : 0
  let attempt = 0
  for (;;) {
    try {
      rmSync(targetPath, options)
      return
    } catch (error) {
      // Mocks or handles outliving Node’s inner retries can still throw; force suppresses only ENOENT.
      if (attempt >= extraAttempts || !isTransientWindowsLockError(error)) {
        throw error
      }
      sleepSync(WINDOWS_RM_RETRY_DELAY_MS)
      attempt += 1
    }
  }
}

export async function removeTree(targetPath: string): Promise<void> {
  await rm(targetPath, transientLockRemovalOptions())
}
