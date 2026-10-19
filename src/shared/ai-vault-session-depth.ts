import { createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
import type { AiVaultListArgs, AiVaultListResult } from './ai-vault-types'

export const DEFAULT_AI_VAULT_SCAN_LIMIT = 1000

export type AiVaultSessionDepth = number | 'unlimited'

export function requestedAiVaultSessionDepth(
  args?: Pick<AiVaultListArgs, 'limit' | 'unlimited'>
): AiVaultSessionDepth {
  if (args?.unlimited === true) {
    return 'unlimited'
  }
  return args?.limit && Number.isFinite(args.limit) && args.limit > 0
    ? Math.floor(args.limit)
    : DEFAULT_AI_VAULT_SCAN_LIMIT
}

// Scanners bound with slice/comparisons, so 'unlimited' resolves to no bound.
// Single owner of the normalization every scan limit goes through.
export function aiVaultScanLimit(args?: Pick<AiVaultListArgs, 'limit' | 'unlimited'>): number {
  const depth = requestedAiVaultSessionDepth(args)
  return depth === 'unlimited' ? Number.POSITIVE_INFINITY : depth
}

export function aiVaultSessionDepthCovers(
  cached: AiVaultSessionDepth,
  requested: AiVaultSessionDepth
): boolean {
  return cached === 'unlimited' || (requested !== 'unlimited' && cached >= requested)
}

// A deeper scan keeps every scoped row it found, so a scoped request reuses only a scan of its
// own depth; a lowered depth otherwise shows the deeper scan's scoped rows again.
export function aiVaultCachedDepthServes(
  cached: AiVaultSessionDepth,
  requested: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): boolean {
  return scopePaths.length > 0 ? cached === requested : aiVaultSessionDepthCovers(cached, requested)
}

// Depth bounds only out-of-scope rows: the scan already budgets in-scope rows per source,
// and its out-of-scope rows are its capped newest set, so a scan result passes through
// unchanged and a cache hit can never show less than the scan it came from.
export function truncateAiVaultListResult(
  result: AiVaultListResult,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  if (depth === 'unlimited') {
    return result
  }
  const inScope = scopePaths.length > 0 ? createAiVaultScopeCwdMatcher(scopePaths) : null
  let outOfScopeCount = 0
  const sessions = result.sessions.filter(
    (session) => inScope?.(session.cwd, session.filePath) === true || outOfScopeCount++ < depth
  )
  return {
    ...result,
    sessions,
    ...(sessions.length !== result.sessions.length ? { fingerprint: undefined } : {})
  }
}
