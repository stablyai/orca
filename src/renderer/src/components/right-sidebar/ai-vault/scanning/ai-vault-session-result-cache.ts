import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import {
  aiVaultCachedDepthServes,
  truncateAiVaultListResult
} from '../../../../../../shared/ai-vault/scanning/ai-vault-session-depth'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

const MAX_CACHED_SESSION_SCOPES = 8
const PERSIST_KEY = 'orca.aiVault.sessionListCache.v1'
/** Sessions carry preview text the list itself never shows; drop it to keep the persisted size bounded. */
const MAX_PERSISTED_SESSIONS = 200

type CachedSessionResult = {
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
  /** The persisted copy without preview text; absent until the first write. */
  persisted?: AiVaultListResult
}

const cachedSessionResults = new Map<string, CachedSessionResult>()

/** Preview messages are hover-only; the list itself reads the summary fields. */
function stripPreviewSessions(result: AiVaultListResult): AiVaultListResult {
  const sessions: AiVaultSession[] = result.sessions
    .slice(0, MAX_PERSISTED_SESSIONS)
    .map((session) => ({ ...session, previewMessages: [] }))
  return { ...result, sessions }
}

function readPersistedCache(): Map<string, CachedSessionResult> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) {
      return new Map()
    }
    const parsed = JSON.parse(raw) as [string, CachedSessionResult][]
    return new Map(parsed)
  } catch {
    return new Map()
  }
}

function writePersistedCache(entries: Map<string, CachedSessionResult>): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify([...entries]))
  } catch {
    // Quota exceeded: the in-memory cache still works; only restart speed is lost.
  }
}

/** Seed the in-memory cache from the persisted copy so a restart shows the last list immediately (#39308). */
function seedFromPersistedCache(): void {
  if (cachedSessionResults.size > 0) {
    return
  }
  for (const [key, entry] of readPersistedCache()) {
    cachedSessionResults.set(key, entry)
  }
}
seedFromPersistedCache()

export function aiVaultSessionResultCacheKey(
  executionHostScope: ExecutionHostScope,
  scopePaths: readonly string[]
): string {
  // JSON keeps the parts unambiguous: a path may legally contain any separator.
  return JSON.stringify([executionHostScope, ...[...new Set(scopePaths)].sort()])
}

export function readCachedAiVaultSessionResult(args: {
  key: string
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
}): AiVaultListResult | null {
  let cached = cachedSessionResults.get(args.key)
  if (!cached) {
    // A restart cleared the in-memory map; check the persisted copy before giving up (#39308).
    seedFromPersistedCache()
    cached = cachedSessionResults.get(args.key)
  }
  if (!cached || !aiVaultCachedDepthServes(cached.limit, args.limit, args.scopePaths)) {
    return null
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, cached)
  return truncateAiVaultListResult(cached.result, args.limit, args.scopePaths)
}

export function cacheAiVaultSessionResult(args: {
  key: string
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
  result: AiVaultListResult
  replaceHostEntries: boolean
}): void {
  if (args.replaceHostEntries) {
    for (const [key, cached] of cachedSessionResults) {
      if (cached.executionHostScope === args.executionHostScope) {
        cachedSessionResults.delete(key)
      }
    }
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, {
    executionHostScope: args.executionHostScope,
    limit: args.limit,
    // Persist the stripped copy; the live result keeps its previews in memory.
    result: args.result,
    persisted: stripPreviewSessions(args.result)
  })
  while (cachedSessionResults.size > MAX_CACHED_SESSION_SCOPES) {
    const oldestKey = cachedSessionResults.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cachedSessionResults.delete(oldestKey)
  }
  writePersistedCache(
    new Map(
      [...cachedSessionResults].map(([key, entry]) => [
        key,
        { ...entry, result: entry.persisted ?? entry.result }
      ])
    )
  )
}

export function resetAiVaultSessionResultCacheForTest(): void {
  cachedSessionResults.clear()
  try {
    localStorage.removeItem(PERSIST_KEY)
  } catch {
    // A test without localStorage just clears the map.
  }
}

export function invalidateAiVaultSessionResults(host: ExecutionHostScope): void {
  for (const [key, entry] of cachedSessionResults) {
    if (entry.executionHostScope === host || entry.executionHostScope === 'all') {
      cachedSessionResults.delete(key)
    }
  }
  writePersistedCache(
    new Map(
      [...cachedSessionResults].map(([key, entry]) => [
        key,
        { ...entry, result: entry.persisted ?? entry.result }
      ])
    )
  )
}
