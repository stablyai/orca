import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import {
  aiVaultSessionDepthCovers,
  truncateAiVaultListResult
} from '../../../../shared/ai-vault-session-depth'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

const MAX_CACHED_SESSION_SCOPES = 8

type CachedSessionResult = {
  executionHostScope: ExecutionHostScope
  limit: AiVaultSessionLimit
  result: AiVaultListResult
}

const cachedSessionResults = new Map<string, CachedSessionResult>()

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
}): void {
  if (args.replaceHostEntries) {
    for (const [key, cached] of cachedSessionResults) {
      if (cached.executionHostScope === args.executionHostScope) {
        cachedSessionResults.delete(key)
      }
    }
  } else {
    const cached = cachedSessionResults.get(args.key)
    if (cached && aiVaultSessionDepthCovers(cached.limit, args.limit)) {
      return
    }
  }
  cachedSessionResults.delete(args.key)
  cachedSessionResults.set(args.key, {
    executionHostScope: args.executionHostScope,
    limit: args.limit,
    result: args.result
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
