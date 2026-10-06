import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope, ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  aiVaultSessionDepthCovers,
  truncateAiVaultListResult
} from '../../../../shared/ai-vault-session-depth'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import { reuseAiVaultListResult } from './ai-vault-session-identity'
import {
  nativeRows,
  mergeAiVaultStructuredMetadata,
  mergeAiVaultStructuredTitleChanges,
  projectAiVaultStructuredTitles,
  applyAiVaultTitleProjection,
  savedAiVaultTitleFromSnapshot,
  type AiVaultTitleProjection,
  type AiVaultSavedTitle,
  type StructuredTitlesByWorktree
} from './ai-vault-structured-title-projection'

const MAX_CACHED_SESSION_SCOPES = 8

type CachedSessionResult = {
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
}

const cachedSessionResults = new Map<string, CachedSessionResult>()
const structuredTitleListeners = new Set<(update: AiVaultTitleProjection) => void>()

export function subscribeAiVaultStructuredTitles(
  listener: (update: AiVaultTitleProjection) => void
): () => void {
  structuredTitleListeners.add(listener)
  return () => {
    structuredTitleListeners.delete(listener)
  }
}

export function projectCachedAiVaultStructuredTitles(tabs: StructuredTitlesByWorktree): void {
  publishTitleProjection({ kind: 'tabs', tabs })
}

export function publishAiVaultSavedTitle(
  snapshot: Pick<RuntimeMobileSessionTabsResult, 'worktree' | 'structuredConversationTitle'>,
  executionHostId: ExecutionHostId
): void {
  const title = savedAiVaultTitleFromSnapshot(snapshot, executionHostId)
  if (title) {
    publishAiVaultSavedTitles([title])
  }
}

export function publishAiVaultSavedTitles(titles: readonly AiVaultSavedTitle[]): void {
  if (titles.length) {
    publishTitleProjection({ kind: 'saved', titles })
  }
}

function publishTitleProjection(update: AiVaultTitleProjection): void {
  for (const cached of cachedSessionResults.values()) {
    const result = applyAiVaultTitleProjection(cached.result, update)
    cached.result = result
  }
  for (const listener of structuredTitleListeners) {
    listener(update)
  }
}

export function cachedAiVaultStructuredSessions(executionHostId?: ExecutionHostId) {
  const sessions = new Map<string, AiVaultListResult['sessions'][number]>()
  for (const cached of cachedSessionResults.values()) {
    for (const index of nativeRows(cached.result)) {
      const row = cached.result.sessions[index]
      if (executionHostId === undefined || row.executionHostId === executionHostId) {
        sessions.set(
          JSON.stringify([row.executionHostId, row.agent, row.sessionId, row.structuredSession]),
          row
        )
      }
    }
  }
  return [...sessions.values()]
}

export function readAiVaultSessionResultSnapshot(key: string): AiVaultListResult | null {
  return cachedSessionResults.get(key)?.result ?? null
}

export function applyAiVaultTitleChangesSince(
  result: AiVaultListResult,
  key: string,
  previous: AiVaultListResult | null
): AiVaultListResult {
  return mergeAiVaultStructuredTitleChanges(result, previous, readAiVaultSessionResultSnapshot(key))
}

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
  const cached = cachedSessionResults.get(args.key)
  if (!cached || !aiVaultSessionDepthCovers(cached.limit, args.limit)) {
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
  result: AiVaultListResult
  replaceHostEntries: boolean
  tabs?: StructuredTitlesByWorktree
}): void {
  const result = args.tabs ? projectAiVaultStructuredTitles(args.result, args.tabs) : args.result
  if (args.replaceHostEntries) {
    for (const [key, cached] of cachedSessionResults) {
      if (cached.executionHostScope === args.executionHostScope) {
        cachedSessionResults.delete(key)
      }
    }
  } else {
    const cached = cachedSessionResults.get(args.key)
    if (cached && aiVaultSessionDepthCovers(cached.limit, args.limit)) {
      cached.result =
        cached.limit === args.limit
          ? reuseAiVaultListResult(cached.result, result)
          : mergeAiVaultStructuredMetadata(cached.result, result)
      return
    }
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, {
    executionHostScope: args.executionHostScope,
    limit: args.limit,
    result
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
