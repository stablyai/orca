import {
  CREATURE_POOL_NAMES,
  creatureNameAtTier,
  creatureNameTier
} from '../worktree/retired-name-registry'

export const CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS = 25

// Why: mixed-version runtimes can still return these legacy conflicts instead
// of performing their own suffix retry, so every client needs one policy.
const RETRYABLE_WORKTREE_CREATE_CONFLICT_PATTERNS = [
  /already exists locally/i,
  /already exists on a remote/i,
  /^Branch ".+" already exists\./i,
  /already has pr #\d+/i
]

export function getClientWorktreeCreateCandidate(value: string, attempt: number): string {
  return attempt === 0 ? value : `${value}-${attempt + 1}`
}

function generatedNameIdentity(value: string): { poolName: string; tier: number } | null {
  const normalized = value.trim().toLowerCase()
  const canonicalTier = creatureNameTier(normalized)
  if (canonicalTier !== null) {
    const poolName =
      canonicalTier === 1 ? normalized : normalized.slice(0, normalized.lastIndexOf('-'))
    return { poolName, tier: canonicalTier }
  }
  let poolName = normalized
  let tier = 1
  let suffixCount = 0
  for (;;) {
    const match = /-(\d{1,6})$/.exec(poolName)
    if (!match) {
      break
    }
    const suffix = Number(match[1])
    if (suffix < 2 || tier + suffix - 1 > 999_999) {
      return null
    }
    tier += suffix - 1
    suffixCount += 1
    poolName = poolName.slice(0, match.index)
  }
  return suffixCount > 1 && CREATURE_POOL_NAMES.has(poolName) ? { poolName, tier } : null
}

export function isGeneratedWorktreeCreateName(value: string): boolean {
  return generatedNameIdentity(value) !== null
}

export function getGeneratedWorktreeCreateRetryCandidate(
  value: string,
  attempt: number,
  minimumTier = 1
): string {
  const identity = generatedNameIdentity(value)
  if (!identity) {
    return getClientWorktreeCreateCandidate(value, attempt)
  }
  return creatureNameAtTier(identity.poolName, Math.max(identity.tier, minimumTier) + attempt)
}

export function isRetryableWorktreeCreateConflict(message: string): boolean {
  return RETRYABLE_WORKTREE_CREATE_CONFLICT_PATTERNS.some((pattern) => pattern.test(message))
}
