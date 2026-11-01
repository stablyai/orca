import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'

/** One signal per row so the list scans as a single column. */
export type AccountSwitchUsage =
  | { kind: 'usage'; usedPercent: number }
  | { kind: 'plan-limit'; resetsAt: number | null; extraUsageAvailable: boolean }
  | { kind: 'none' }

/** Past this many accounts the list gets a filter, groups and a bounded scroll region. */
export const ACCOUNT_SWITCH_LONG_LIST_THRESHOLD = 8

function getGeneralPlanWindows(limits: ProviderRateLimits): RateLimitWindow[] {
  return [limits.session, limits.weekly, limits.monthly].filter(
    (window): window is RateLimitWindow => window != null
  )
}

/** An inactive account whose usage fetch failed without any window to show. */
export function isUnavailableInactiveUsage(limits: ProviderRateLimits | null | undefined): boolean {
  return (
    limits?.status === 'error' &&
    !limits.session &&
    !limits.weekly &&
    !limits.fableWeekly &&
    !limits.monthly
  )
}

export function getAccountSwitchUsage(limits: ProviderRateLimits | null): AccountSwitchUsage {
  if (!limits) {
    return { kind: 'none' }
  }
  const windows = getGeneralPlanWindows(limits)
  const exhausted = windows.filter((window) => clampUsedPercent(window.usedPercent) >= 100)
  if (exhausted.length > 0) {
    const known = exhausted
      .map((window) => window.resetsAt)
      .filter((at): at is number => at != null)
    const extra = limits.extraUsage
    const extraUsageAvailable = Boolean(
      extra?.enabled &&
      (extra.unit === 'credits'
        ? extra.unlimited || extra.balance > 0
        : extra.balance !== null && extra.balance > 0)
    )
    return {
      kind: 'plan-limit',
      resetsAt: known.length > 0 ? Math.max(...known) : null,
      extraUsageAvailable
    }
  }
  // Weekly first so rows compare like with like; fall back to whatever window the plan reports.
  const headline = limits.weekly ?? limits.session ?? limits.fableWeekly ?? limits.monthly
  return headline
    ? { kind: 'usage', usedPercent: clampUsedPercent(headline.usedPercent) }
    : { kind: 'none' }
}

export type AccountSwitchListEntry = {
  key: string
  /** Null for the System default row. */
  email: string | null
  systemDefaultEmail?: string | null
  workspace: string | null
  identifier: string | null
  usage: AccountSwitchUsage
  needsSignIn: boolean
}

export type AccountSwitchSort = 'name' | 'least-used'

export type AccountSwitchGroupKind = 'default' | 'accounts' | 'plan-limit' | 'sign-in'

export type AccountSwitchGroup<T extends AccountSwitchListEntry> = {
  kind: AccountSwitchGroupKind
  entries: T[]
}

export function splitEmailForDisplay(email: string): { local: string; domain: string } {
  const at = email.lastIndexOf('@')
  return at > 0
    ? { local: email.slice(0, at), domain: email.slice(at) }
    : { local: email, domain: '' }
}

/** The workspace most accounts share; rows only label a workspace that differs from it. */
export function getPrevailingWorkspace(entries: readonly AccountSwitchListEntry[]): string | null {
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestCount = 0
  for (const entry of entries) {
    if (entry.email === null || !entry.workspace) {
      continue
    }
    const count = (counts.get(entry.workspace) ?? 0) + 1
    counts.set(entry.workspace, count)
    if (count > bestCount) {
      best = entry.workspace
      bestCount = count
    }
  }
  return bestCount > 1 ? best : null
}

/** Lower-cased emails that more than one row uses. */
export function getSharedEmails(entries: readonly AccountSwitchListEntry[]): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const entry of entries) {
    const email = entry.email?.toLowerCase()
    if (!email) {
      continue
    }
    if (seen.has(email)) {
      shared.add(email)
    }
    seen.add(email)
  }
  return shared
}

export function filterAccountSwitchEntries<T extends AccountSwitchListEntry>(
  entries: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...entries]
  }
  return entries.filter((entry) =>
    [entry.email, entry.systemDefaultEmail, entry.workspace, entry.identifier].some(
      (value) => value != null && value.toLowerCase().includes(needle)
    )
  )
}

function compareByName(a: AccountSwitchListEntry, b: AccountSwitchListEntry): number {
  return (
    (a.email ?? '').localeCompare(b.email ?? '') ||
    (a.workspace ?? '').localeCompare(b.workspace ?? '') ||
    (a.identifier ?? '').localeCompare(b.identifier ?? '')
  )
}

function usageSortValue(entry: AccountSwitchListEntry): number {
  return entry.usage.kind === 'usage' ? entry.usage.usedPercent : Number.POSITIVE_INFINITY
}

/** Keep plan limits separate from sign-in state without claiming unknown accounts are usable. */
export function groupAccountSwitchEntries<T extends AccountSwitchListEntry>(
  entries: readonly T[],
  sort: AccountSwitchSort
): AccountSwitchGroup<T>[] {
  const groups: Record<AccountSwitchGroupKind, T[]> = {
    default: [],
    accounts: [],
    'plan-limit': [],
    'sign-in': []
  }
  for (const entry of entries) {
    if (entry.email === null) {
      groups.default.push(entry)
    } else if (entry.needsSignIn) {
      groups['sign-in'].push(entry)
    } else if (entry.usage.kind === 'plan-limit' && !entry.usage.extraUsageAvailable) {
      groups['plan-limit'].push(entry)
    } else {
      groups.accounts.push(entry)
    }
  }
  groups.accounts.sort(
    sort === 'least-used'
      ? (a, b) => usageSortValue(a) - usageSortValue(b) || compareByName(a, b)
      : compareByName
  )
  groups['plan-limit'].sort((a, b) => {
    const aReset = a.usage.kind === 'plan-limit' ? (a.usage.resetsAt ?? Infinity) : Infinity
    const bReset = b.usage.kind === 'plan-limit' ? (b.usage.resetsAt ?? Infinity) : Infinity
    return aReset - bReset || compareByName(a, b)
  })
  groups['sign-in'].sort(compareByName)
  return (['default', 'accounts', 'plan-limit', 'sign-in'] as const)
    .map((kind) => ({ kind, entries: groups[kind] }))
    .filter((group) => group.entries.length > 0)
}
