import type { UsageReadingAccount } from './rate-limit-types'

type StampedReading = {
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

// A failure with no earlier windows is still that account's state, so it names the attempt.
function readingSlot(reading: StampedReading): UsageReadingAccount | undefined {
  const metadata = reading.usageMetadata
  return (
    metadata?.readingAccount ?? (reading.status === 'ok' ? undefined : metadata?.attemptedAccount)
  )
}

/** Index by the slot each reading names, never by which row a roster marks selected: the
 *  selection can change while a fetch is in flight. Unstamped readings (older hosts) name no one. */
export function indexAccountUsageObservations<T extends StampedReading>(
  active: T | null | undefined,
  inactive: readonly { accountId: string; rateLimits: T | null }[] | null | undefined
): AccountUsageObservations<T> {
  const readings = new Map<string, T>()
  const add = (reading: T | null | undefined, cacheId?: string): void => {
    const account = reading ? readingSlot(reading) : undefined
    const key = account ? slotKey(account) : null
    // A cached entry must name the account it is cached under.
    if (
      !reading ||
      !account ||
      key === null ||
      (cacheId !== undefined && cacheId !== account.accountId)
    ) {
      return
    }
    const current = readings.get(key)
    if (!current || current.updatedAt < reading.updatedAt) {
      readings.set(key, reading)
    }
  }
  add(active)
  for (const entry of inactive ?? []) {
    add(entry.rateLimits, entry.accountId)
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
