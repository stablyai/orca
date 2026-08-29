import { isPathInsideOrEqual } from './cross-platform-path'
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

export function truncateAiVaultListResult(
  result: AiVaultListResult,
  depth: AiVaultSessionDepth,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  if (depth === 'unlimited') {
    return result
  }
  const selectedIds = new Set(result.sessions.slice(0, depth).map((session) => session.id))
  if (scopePaths.length > 0) {
    let scopedCount = 0
    for (const session of result.sessions) {
      const cwd = session.cwd
      if (cwd && scopePaths.some((scopePath) => isPathInsideOrEqual(scopePath, cwd))) {
        selectedIds.add(session.id)
        if (++scopedCount >= depth) {
          break
        }
      }
    }
  }
  return { ...result, sessions: result.sessions.filter((session) => selectedIds.has(session.id)) }
}
