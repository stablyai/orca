import type { UsageReadingAccount } from './rate-limit-types'
import { CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID } from '../../agent-accounts/claude/claude-system-default-usage'

type StampedReading = {
  session: unknown
  weekly: unknown
  status: string
  updatedAt: number
  usageMetadata?: {
    readingAccount?: UsageReadingAccount
    attemptedAccount?: UsageReadingAccount
  } | null
}

/** Readings keyed by the account slot each one names, from one owner's snapshot. */
export type AccountUsageObservations<T extends StampedReading> = ReadonlyMap<string, T>

// A WSL slot belongs to one named distro, never to whichever distro is the default.
function slotKey(slot: UsageReadingAccount): string | null {
  if (slot.runtime === 'host') {
    return JSON.stringify([slot.accountId, 'host'])
  }
  return slot.wslDistro
    ? JSON.stringify([slot.accountId, 'wsl', slot.wslDistro.toLowerCase()])
    : null
}

export function isSameUsageSlot(
  left: UsageReadingAccount | null | undefined,
  right: UsageReadingAccount | null | undefined
): boolean {
  const key = left ? slotKey(left) : null
  return key !== null && right !== null && right !== undefined && key === slotKey(right)
}

// Windows and plan kept from an unnamed reading through a failed attempt belong to no one;
// the failure itself is still the tried account's state.
function readingSlot<T extends StampedReading>(
  reading: T
): { account: UsageReadingAccount; reading: T } | undefined {
  const metadata = reading.usageMetadata
  if (metadata?.readingAccount) {
    return { account: metadata.readingAccount, reading }
  }
  if (reading.status === 'ok' || !metadata?.attemptedAccount) {
    return undefined
  }
  return {
    account: metadata.attemptedAccount,
    reading: {
      ...reading,
      session: null,
      weekly: null,
      fableWeekly: null,
      monthly: null,
      buckets: [],
      planType: null,
      extraUsage: null,
      rateLimitResetCredits: null
    }
  }
}

/** Index by the slot each reading names, never by which row a roster marks selected: the
 *  selection can change while a fetch is in flight. Unstamped readings (older hosts) name no one. */
export function indexAccountUsageObservations<T extends StampedReading>(
  active: T | null | undefined,
  inactive: readonly { accountId: string; rateLimits: T | null }[] | null | undefined
): AccountUsageObservations<T> {
  const readings = new Map<string, T>()
  const add = (stored: T | null | undefined, cacheId?: string | null): void => {
    const slot = stored ? readingSlot(stored) : undefined
    const key = slot ? slotKey(slot.account) : null
    // A cached entry must name the account it is cached under.
    if (!slot || key === null || (cacheId !== undefined && cacheId !== slot.account.accountId)) {
      return
    }
    const current = readings.get(key)
    if (!current || current.updatedAt < slot.reading.updatedAt) {
      readings.set(key, slot.reading)
    }
  }
  add(active)
  for (const entry of inactive ?? []) {
    // System default has no saved id, so the host caches its reading under a reserved key.
    add(
      entry.rateLimits,
      entry.accountId === CLAUDE_HOST_SYSTEM_DEFAULT_USAGE_ID ? null : entry.accountId
    )
  }
  return readings
}

export function getObservedAccountUsage<T extends StampedReading>(
  observations: AccountUsageObservations<T>,
  slot: UsageReadingAccount
): T | null {
  const key = slotKey(slot)
  return key === null ? null : (observations.get(key) ?? null)
}
