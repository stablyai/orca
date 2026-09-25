import { hostStableKey, parseHostStableKey } from './automation-owner-key'
import type { StableAutomationCatalogRef } from './automation-owner-ref'

/**
 * The Automations page host filter.
 *
 * Only the *stable* form is ever persisted: a rename, reconnect, runtime
 * re-pair, or SSH reconnect must not lose the user's selection, while data and
 * actions captured from an old incarnation still have to be discarded.
 */
export type AutomationHostFilter =
  | { kind: 'all' }
  | { kind: 'host'; host: StableAutomationCatalogRef }

/** On-disk shape: the canonical `hostStableKey` string plus a discriminator. */
export type PersistedAutomationHostFilter = { kind: 'all' } | { kind: 'host'; hostKey: string }

/** Shared identity so an unchanged hydration can return the same reference. */
export const ALL_AUTOMATION_HOSTS_FILTER: AutomationHostFilter = Object.freeze({ kind: 'all' })

export function toPersistedAutomationHostFilter(
  filter: AutomationHostFilter
): PersistedAutomationHostFilter {
  return filter.kind === 'all'
    ? { kind: 'all' }
    : { kind: 'host', hostKey: hostStableKey(filter.host) }
}

/** Never throws: a malformed, legacy, or hand-edited value degrades to All hosts. */
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

/** Stable key of the selected host, or null under All hosts. */
export function automationHostFilterStableKey(filter: AutomationHostFilter): string | null {
  return filter.kind === 'all' ? null : hostStableKey(filter.host)
}

export function automationHostFiltersEqual(
  a: AutomationHostFilter,
  b: AutomationHostFilter
): boolean {
  return automationHostFilterStableKey(a) === automationHostFilterStableKey(b)
}
