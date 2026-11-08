import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import {
  aiVaultCachedDepthServes,
  aiVaultSessionDepthCovers,
  truncateAiVaultListResult
} from '../../../../../../shared/ai-vault/scanning/ai-vault-session-depth'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'
import {
  forgetSavedAiVaultSession,
  readSavedAiVaultSessionList,
  type SavedAiVaultSessionList
} from './ai-vault-saved-session-lists'

const MAX_CACHED_SESSION_SCOPES = 8

type CachedSessionResult = {
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
  /** Outdated by a rescan or a chat link change: shown while refreshing, never reused as current. */
  stale: boolean
}

const cachedSessionResults = new Map<string, CachedSessionResult>()

export function aiVaultSessionResultCacheKey(
  executionHostScope: ExecutionHostScope,
  scopePaths: readonly string[],
  scopeOnly = false
): string {
  // JSON keeps the parts unambiguous: a path may legally contain any separator.
  return JSON.stringify([
    executionHostScope,
    ...(scopeOnly ? [{ scopeOnly }] : []),
    ...[...new Set(scopePaths)].sort()
  ])
}

export function readCachedAiVaultSessionResult(args: {
  key: string
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
}): AiVaultListResult | null {
  const cached = cachedSessionResults.get(args.key)
  if (
    !cached ||
    cached.stale ||
    !aiVaultCachedDepthServes(cached.limit, args.limit, args.scopePaths)
  ) {
    return null
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, cached)
  return truncateAiVaultListResult(cached.result, args.limit, args.scopePaths)
}

/** The last list this scope showed, current or not, from this run or a previous one, at the depth it holds. */
export async function readLastAiVaultSessionResult(args: {
  key: string
  limit: AiVaultSessionLimit
  scopePaths: readonly string[]
}): Promise<SavedAiVaultSessionList | null> {
  const last = cachedSessionResults.get(args.key) ?? (await readSavedAiVaultSessionList(args.key))
  if (!last) {
    return null
  }
  return aiVaultSessionDepthCovers(last.limit, args.limit)
    ? {
        limit: args.limit,
        result: truncateAiVaultListResult(last.result, args.limit, args.scopePaths)
      }
    : { limit: last.limit, result: last.result }
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
    markAiVaultSessionResultsStale((host) => host === args.executionHostScope)
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, {
    executionHostScope: args.executionHostScope,
    limit: args.limit,
    result: args.result,
    stale: false
  })
  while (cachedSessionResults.size > MAX_CACHED_SESSION_SCOPES) {
    const oldestKey = cachedSessionResults.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    cachedSessionResults.delete(oldestKey)
  }
}

export function resetAiVaultSessionResultCacheForTest(): void {
  cachedSessionResults.clear()
}

function markAiVaultSessionResultsStale(matches: (host: ExecutionHostScope) => boolean): void {
  for (const entry of cachedSessionResults.values()) {
    if (matches(entry.executionHostScope)) {
      entry.stale = true
    }
  }
}

export function invalidateAiVaultSessionResults(host: ExecutionHostScope): void {
  markAiVaultSessionResultsStale((entry) => entry === host || entry === 'all')
}

/** Drops a deleted session from every kept list, so no scope paints it while it rescans. */
export function forgetAiVaultSessionResult(sessionId: string): void {
  for (const entry of cachedSessionResults.values()) {
    const sessions = entry.result.sessions.filter((session) => session.id !== sessionId)
    if (sessions.length !== entry.result.sessions.length) {
      entry.result = { ...entry.result, sessions, fingerprint: undefined }
      entry.stale = true
    }
  }
  void forgetSavedAiVaultSession(sessionId)
}
