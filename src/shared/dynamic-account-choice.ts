import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'

export type DynamicAccountCandidate = {
  /** Null is the provider's own sign-in (System default). */
  accountId: string | null
  rateLimits: ProviderRateLimits | null
}

/** Launches sent to each account since its reading, which that reading does not show yet. */
export type DynamicAccountPicks = Map<string | null, { readingUpdatedAt: number; count: number }>

const DYNAMIC_ACCOUNT_READING_MAX_AGE_MS = 30 * 60_000

export function isDynamicAccountReadingFresh(
  limits: ProviderRateLimits | null,
  now: number
): limits is ProviderRateLimits {
  return limits !== null && now - limits.updatedAt <= DYNAMIC_ACCOUNT_READING_MAX_AGE_MS
}

function usedPercentAt(window: RateLimitWindow, now: number): number {
  return window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedPercent
}

/** Spends quota that expires first: the soonest weekly reset that keeps the margin, else null. */
export function chooseDynamicAccount(
  candidates: readonly DynamicAccountCandidate[],
  marginPercent: number,
  now: number,
  picks?: DynamicAccountPicks
): DynamicAccountCandidate | null {
  let best: { candidate: DynamicAccountCandidate; weeklyReset: number; headroom: number } | null =
    null
  for (const candidate of candidates) {
    const limits = candidate.rateLimits
    if (!isDynamicAccountReadingFresh(limits, now)) {
      continue
    }
    // Model-only windows (Fable, buckets) never block every model, matching rateLimitSpentUntil.
    const windows = [limits.session, limits.weekly, limits.monthly].filter(
      (window): window is RateLimitWindow => !!window
    )
    if (windows.length === 0) {
      continue
    }
    // Each launch the reading does not show yet spends one margin, so a burst spreads out.
    const pending = picks?.get(candidate.accountId)
    const unseen = pending && pending.readingUpdatedAt >= limits.updatedAt ? pending.count : 0
    const headroom =
      Math.min(...windows.map((window) => 100 - usedPercentAt(window, now))) -
      unseen * marginPercent
    if (headroom <= 0 || headroom < marginPercent) {
      continue
    }
    const weeklyResetsAt = limits.weekly?.resetsAt ?? null
    const weeklyReset =
      weeklyResetsAt !== null && weeklyResetsAt > now ? weeklyResetsAt : Number.POSITIVE_INFINITY
    if (
      !best ||
      weeklyReset < best.weeklyReset ||
      (weeklyReset === best.weeklyReset && headroom > best.headroom)
    ) {
      best = { candidate, weeklyReset, headroom }
    }
  }
  return best?.candidate ?? null
}

export function countDynamicAccountPick(
  picks: DynamicAccountPicks,
  pick: DynamicAccountCandidate
): void {
  const readingUpdatedAt = pick.rateLimits?.updatedAt ?? 0
  const pending = picks.get(pick.accountId)
  const count = pending && pending.readingUpdatedAt >= readingUpdatedAt ? pending.count + 1 : 1
  picks.set(pick.accountId, { readingUpdatedAt, count })
}
