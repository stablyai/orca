// Windows handles from AV/indexers/children/DLLs can briefly outlive deletion. Share bounded EBUSY/ENOTEMPTY/EPERM retries with teardown so passing tests do not fail during cleanup.

import type { RmOptions } from 'node:fs'
import { rmSync } from 'node:fs'
import { rm as nodeRm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const WINDOWS_RM_MAX_RETRIES = 8
export const WINDOWS_RM_RETRY_DELAY_MS = 150
const WINDOWS_REMOVE_PASS_DELAYS_MS = [250, 500, 1_000, 2_000]

/** For `rmSync` only: its native retry loop is top-level, but async `rm` retries per entry and multiplies. */
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

type AsyncRm = (path: string, options: RmOptions) => Promise<void>

/** Recursive async delete; a transient Windows lock repeats the whole pass from one bounded budget. */
export async function removeTree(
  targetPath: string,
  options: { rm?: AsyncRm; signal?: AbortSignal } = {}
): Promise<void> {
  const rm = options.rm ?? nodeRm
  const passDelays = process.platform === 'win32' ? WINDOWS_REMOVE_PASS_DELAYS_MS : []
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted()
    try {
      // Never `maxRetries` here: async rm retries each nested entry and never stops siblings,
      // so one held-open file multiplies the work at every directory level.
      await rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= passDelays.length || !isTransientWindowsLockError(error)) {
        throw error
      }
    }
    // A pass in flight cannot be cancelled; abort is honored between passes.
    await delay(passDelays[attempt], undefined, { signal: options.signal })
  }
}
