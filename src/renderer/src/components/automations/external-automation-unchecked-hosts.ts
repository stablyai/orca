/**
 * Hosts whose external managers a probe never answered for.
 *
 * A probe that failed is not a host with nothing on it. Without this line the
 * list would render an unreachable host exactly like a clean one, which is the
 * one claim the page has no evidence for.
 */

import { translate } from '@/i18n/i18n'
import { ownerKey } from '../../../../shared/automation-owner-key'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { ScopedExternalAutomationFailure } from './external-automation-scope-client'

export function externalAutomationUncheckedHostLabels(
  failures: readonly ScopedExternalAutomationFailure[],
  entries: readonly AutomationHostCatalogEntry[]
): string[] {
  const labelByOwnerKey = new Map<string, string>()
  for (const entry of entries) {
    if (entry.owner) {
      labelByOwnerKey.set(ownerKey(entry.owner), entry.label)
    }
  }
  const labels: string[] = []
  const seen = new Set<string>()
  // Per host, not per provider: two failed providers are still one unchecked host.
  for (const failure of failures) {
    const key = ownerKey(failure.scope.owner)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    labels.push(
      labelByOwnerKey.get(key) ??
        translate('auto.components.automations.emptyState.unknownHost', 'this host')
    )
  }
  return labels
}

/** Distinct from the empty state on purpose: unchecked is not the same as clean. */
export function externalAutomationUncheckedNotice(
  failures: readonly ScopedExternalAutomationFailure[],
  entries: readonly AutomationHostCatalogEntry[]
): string | null {
  const labels = externalAutomationUncheckedHostLabels(failures, entries)
  if (labels.length === 0) {
    return null
  }
  if (labels.length === 1) {
    return translate(
      'auto.components.automations.externalScope.uncheckedHost',
      'External automation managers on {{hostLabel}} could not be checked.',
      { hostLabel: labels[0] }
    )
  }
  return translate(
    'auto.components.automations.externalScope.uncheckedHosts',
    'External automation managers on {{count}} hosts could not be checked.',
    { count: labels.length }
  )
}
