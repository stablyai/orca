import { aiVaultSessionInScope, createAiVaultScopeCwdMatcher } from './ai-vault-scope-cwd-match'
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

// Normalize unlimited to no bound for scanner slices/comparisons; keep one owner for all scan limits.
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

// Reuse scoped scans only at equal depth or reduced requests would still display deeper scoped results.
export function aiVaultCachedDepthServes(
  cached: AiVaultSessionDepth,
  requested: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): boolean {
  return scopePaths.length > 0 ? cached === requested : aiVaultSessionDepthCovers(cached, requested)
}

// Depth caps only out-of-scope rows; scoped sources have their own budgets. Preserve scan results so cache hits cannot display fewer rows.
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
    (session) =>
      (inScope !== null && aiVaultSessionInScope(inScope, session)) || outOfScopeCount++ < depth
  )
  return {
    ...result,
    sessions,
    ...(sessions.length !== result.sessions.length ? { fingerprint: undefined } : {})
  }
}
