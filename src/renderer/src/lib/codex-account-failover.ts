import type { CodexManagedAccountSummary } from '../../../shared/types'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../../shared/rate-limit-types'

function getWindowUsage(window: RateLimitWindow | null | undefined): number | null {
  if (!window) {
    return null
  }
  if (!Number.isFinite(window.usedPercent)) {
    return null
  }
  return Math.min(100, Math.max(0, window.usedPercent))
}

export function isCodexUsageLimitReached(limits: ProviderRateLimits | null): boolean {
  if (!limits) {
    return false
  }

  if (getWindowUsage(limits.session) === 100 || getWindowUsage(limits.weekly) === 100) {
    return true
  }

  const error = limits.error?.toLowerCase() ?? ''
  return error.includes('usage limit') || (error.includes('limit') && error.includes('try again'))
}

function getCodexAvailabilityScore(limits: ProviderRateLimits | null): number | null {
  if (!limits) {
    return null
  }

  const windows = [getWindowUsage(limits.session), getWindowUsage(limits.weekly)].filter(
    (value): value is number => value !== null
  )
  if (windows.length === 0) {
    return null
  }
  return Math.max(...windows)
}

type CodexFailoverInput = {
  activeAccountId: string | null
  activeCodexUsage: ProviderRateLimits | null
  accounts: CodexManagedAccountSummary[]
  inactiveCodexAccounts: InactiveAccountUsage[]
}

export function chooseCodexFailoverAccount(args: CodexFailoverInput): string | null {
  if (!isCodexUsageLimitReached(args.activeCodexUsage)) {
    return null
  }

  const inactiveUsageByAccountId = new Map(
    args.inactiveCodexAccounts.map((entry) => [entry.accountId, entry.rateLimits] as const)
  )

  let bestAccountId: string | null = null
  let bestScore: number | null = null
  let bestUpdatedAt = -1

  for (const account of args.accounts) {
    if (account.id === args.activeAccountId) {
      continue
    }

    const score = getCodexAvailabilityScore(inactiveUsageByAccountId.get(account.id) ?? null)
    if (score === null || score >= 100) {
      continue
    }

    if (
      bestScore === null ||
      score < bestScore ||
      (score === bestScore && account.updatedAt > bestUpdatedAt)
    ) {
      bestAccountId = account.id
      bestScore = score
      bestUpdatedAt = account.updatedAt
    }
  }

  return bestAccountId
}
