import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget,
  RateLimitWindow
} from './rate-limit-types'
import type { CodexManagedAccountSummary } from './types'

export type CodexResetCreditExpectedScope = {
  target: RateLimitRuntimeTarget
  accountId: string
  accountRevision: number
  offerRevision: string
}

type BuildCodexResetCreditExpectedScopeOptions = {
  target: RateLimitRuntimeTarget
  account: Pick<
    CodexManagedAccountSummary,
    'id' | 'managedHomeRuntime' | 'wslDistro' | 'updatedAt'
  > | null
  limits: ProviderRateLimits | null
}

function windowRevision(window: RateLimitWindow | null): readonly unknown[] | null {
  if (!window) {
    return null
  }
  return [window.usedPercent, window.windowMinutes, window.resetsAt]
}

function buildOfferRevision(limits: ProviderRateLimits): string {
  const credits = limits.rateLimitResetCredits
  const creditRows = [...(credits?.credits ?? [])]
    .map((credit) => [credit.status, credit.expiresAt, credit.grantedAt] as const)
    .sort((left, right) => {
      const leftKey = JSON.stringify(left)
      const rightKey = JSON.stringify(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })

  // Why: clients treat this as an opaque compare-and-swap token. Including the
  // fetched-at revision makes a refresh invalidate a confirmation based on old quota data.
  return `v1:${JSON.stringify([
    credits?.availableCount ?? 0,
    credits?.totalEarnedCount ?? null,
    credits?.nextExpiresAt ?? null,
    creditRows,
    windowRevision(limits.session),
    windowRevision(limits.weekly),
    limits.updatedAt
  ])}`
}

export function buildCodexResetCreditExpectedScope({
  target,
  account,
  limits
}: BuildCodexResetCreditExpectedScopeOptions): CodexResetCreditExpectedScope | null {
  if (!account || limits?.provider !== 'codex') {
    return null
  }
  if ((limits.rateLimitResetCredits?.availableCount ?? 0) <= 0) {
    return null
  }
  if (
    !account.id.trim() ||
    account.id.length > 512 ||
    !Number.isSafeInteger(account.updatedAt) ||
    account.updatedAt < 0 ||
    !Number.isSafeInteger(limits.updatedAt) ||
    limits.updatedAt < 0
  ) {
    return null
  }

  const accountRuntime = account.managedHomeRuntime ?? 'host'
  if (target.runtime === 'host') {
    if (target.wslDistro !== null || accountRuntime !== 'host') {
      return null
    }
  } else {
    const targetDistro = target.wslDistro?.trim()
    const accountDistro = account.wslDistro?.trim()
    if (
      !targetDistro ||
      targetDistro.length > 255 ||
      accountRuntime !== 'wsl' ||
      accountDistro !== targetDistro
    ) {
      return null
    }
  }

  const offerRevision = buildOfferRevision(limits)
  if (offerRevision.length > 4_096) {
    return null
  }

  return {
    target: {
      runtime: target.runtime,
      wslDistro: target.runtime === 'wsl' ? target.wslDistro!.trim() : null
    },
    accountId: account.id,
    accountRevision: account.updatedAt,
    offerRevision
  }
}
