import { hostStableKey, parseHostStableKey } from './automation-owner-key'
import type { StableAutomationCatalogRef } from './automation-owner-ref'

/**
 * The Automations page host filter.
 *
 * Only the stable form is ever persisted so reconnects and renames do not
 * drop the user's selected host.
 */
export type AutomationHostFilter =
  | { kind: 'all' }
  | { kind: 'host'; host: StableAutomationCatalogRef }

/** On-disk shape: the canonical hostStableKey string plus a discriminator. */
export type PersistedAutomationHostFilter = { kind: 'all' } | { kind: 'host'; hostKey: string }

/** Shared identity so unchanged hydration can reuse the same reference. */
export const ALL_AUTOMATION_HOSTS_FILTER: AutomationHostFilter = Object.freeze({ kind: 'all' })

export function toPersistedAutomationHostFilter(
  filter: AutomationHostFilter
): PersistedAutomationHostFilter {
  return filter.kind === 'all'
    ? { kind: 'all' }
    : { kind: 'host', hostKey: hostStableKey(filter.host) }
}

/** Never throws: malformed or legacy values degrade to the all-hosts filter. */
export function parsePersistedAutomationHostFilter(value: unknown): AutomationHostFilter {
  if (!value || typeof value !== 'object') {
    return ALL_AUTOMATION_HOSTS_FILTER
  }
  const record = value as Partial<Record<'kind' | 'hostKey', unknown>>
  if (record.kind !== 'host' || typeof record.hostKey !== 'string') {
    return ALL_AUTOMATION_HOSTS_FILTER
  }
  const host = parseHostStableKey(record.hostKey)
  return host ? { kind: 'host', host } : ALL_AUTOMATION_HOSTS_FILTER
}

/** Stable key of the selected host, or null for all hosts. */
export function automationHostFilterStableKey(filter: AutomationHostFilter): string | null {
  return filter.kind === 'all' ? null : hostStableKey(filter.host)
}

export function automationHostFiltersEqual(
  a: AutomationHostFilter,
  b: AutomationHostFilter
): boolean {
  return automationHostFilterStableKey(a) === automationHostFilterStableKey(b)
}
