import type { PersistedRuntimeEnvironment } from '../host-catalog/runtime-environments'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'

// Throttle lastUsedAt: per-RPC secure-file/Windows ACL rewrites block main; coarse freshness is enough.
export const LAST_USED_PERSIST_INTERVAL_MS = 60_000

// Why: the throttle is per server, so 100 servers in use meant 100 registry rewrites a minute.
// After a write, a stale lastUsedAt rides on the next one, which comes at most one interval later.
type DeferredLastUsed = {
  writtenAt: number
  usedAt: Map<string, number>
  flush: ReturnType<typeof setTimeout> | null
}
const deferredLastUsed = new Map<string, DeferredLastUsed>()
let flushesOnExit = false

export function deferLastUsed(userDataPath: string, environmentId: string, now: number): boolean {
  const deferred = deferredLastUsed.get(userDataPath)
  if (
    !deferred ||
    now < deferred.writtenAt ||
    now - deferred.writtenAt >= LAST_USED_PERSIST_INTERVAL_MS
  ) {
    return false
  }
  deferred.usedAt.set(environmentId, Math.max(now, deferred.usedAt.get(environmentId) ?? now))
  if (!deferred.flush) {
    scheduleFlush(userDataPath, deferred, deferred.writtenAt + LAST_USED_PERSIST_INTERVAL_MS - now)
  }
  return true
}

export function withDeferredLastUsed(
  userDataPath: string,
  entry: PersistedRuntimeEnvironment
): PersistedRuntimeEnvironment {
  const usedAt = deferredLastUsed.get(userDataPath)?.usedAt.get(entry.id)
  return usedAt !== undefined && (entry.lastUsedAt == null || usedAt > entry.lastUsedAt)
    ? { ...entry, lastUsedAt: usedAt, updatedAt: Math.max(entry.updatedAt, usedAt) }
    : entry
}

export function writeMarkedUse(
  userDataPath: string,
  environments: PersistedRuntimeEnvironment[],
  writtenAt: number
): void {
  writeEnvironmentStore(userDataPath, { version: 1, environments })
  const deferred = deferredLastUsed.get(userDataPath)
  if (deferred?.flush) {
    clearTimeout(deferred.flush)
  }
  deferredLastUsed.set(userDataPath, { writtenAt, usedAt: new Map(), flush: null })
}

function scheduleFlush(userDataPath: string, deferred: DeferredLastUsed, delayMs: number): void {
  deferred.flush = setTimeout(() => flushDeferredLastUsed(userDataPath), delayMs)
  if (typeof deferred.flush.unref === 'function') {
    deferred.flush.unref()
  }
  // A one-shot CLI or a quitting app exits before the timer; its last uses still reach the file.
  if (!flushesOnExit) {
    flushesOnExit = true
    process.once('exit', () => {
      for (const [path, pending] of deferredLastUsed) {
        if (pending.flush) {
          flushDeferredLastUsed(path)
        }
      }
    })
  }
}

function flushDeferredLastUsed(userDataPath: string): void {
  try {
    const store = readPersistedEnvironmentStore(userDataPath)
    writeMarkedUse(
      userDataPath,
      store.environments.map((entry) => withDeferredLastUsed(userDataPath, entry)),
      Date.now()
    )
  } catch (error) {
    scheduleFlush(userDataPath, deferredLastUsed.get(userDataPath)!, LAST_USED_PERSIST_INTERVAL_MS)
    console.warn(
      'Skipped deferred last-used bookkeeping for saved servers:',
      error instanceof Error ? error.message : error
    )
  }
}
