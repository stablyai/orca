import { translate } from '@/i18n/i18n'
import type {
  AutomationHostCatalogEntry,
  AutomationHostScopeGap
} from './automation-host-catalog-types'
import type { AutomationHostStatusDescriptor } from './automation-host-status-descriptors'

/**
 * Copy for the query-contract axis.
 *
 * Every degraded entry shares one consequence — view only — but not one cause.
 * A removed target, a target we have not verified since the connection dropped,
 * and a server that advertises no host scoping each get their own sentence, so
 * the badge never claims a server is old on the strength of missing evidence.
 */

const VIEW_ONLY_LABEL = (): string =>
  translate('auto.components.automations.hostStatus.query.viewOnly', 'View only')

function scopeGapDescriptor(gap: AutomationHostScopeGap): AutomationHostStatusDescriptor {
  switch (gap) {
    case 'target-removed':
      return {
        id: 'query-target-removed',
        label: VIEW_ONLY_LABEL(),
        description: translate(
          'auto.components.automations.hostStatus.query.targetRemovedDescription',
          'This host was removed, so its automations can no longer be edited or run from here.'
        ),
        tone: 'attention',
        isDefault: false
      }
    case 'target-unverified':
      // Why quiet: this is missing evidence, not a fault; it clears on reconnect.
      return {
        id: 'query-target-unverified',
        label: VIEW_ONLY_LABEL(),
        description: translate(
          'auto.components.automations.hostStatus.query.targetUnverifiedDescription',
          'This host has not been verified since its connection dropped, so its automations cannot be edited or run from here.'
        ),
        tone: 'quiet',
        isDefault: false
      }
    case 'target-unregistered':
      return {
        id: 'query-target-unregistered',
        label: VIEW_ONLY_LABEL(),
        description: translate(
          'auto.components.automations.hostStatus.query.targetUnregisteredDescription',
          'This host has no registration record, so its automations cannot be edited or run from here.'
        ),
        tone: 'attention',
        isDefault: false
      }
    case 'authority-unscoped':
      return {
        id: 'query-legacy-unscoped',
        label: VIEW_ONLY_LABEL(),
        description: translate(
          'auto.components.automations.hostStatus.query.legacyUnscopedDescription',
          'This server lists automations without host scoping, so they cannot be edited or run from here.'
        ),
        tone: 'attention',
        isDefault: false
      }
  }
}

/** Null for `scoped`; the degraded contracts stay distinct rather than sharing one badge. */
export function hostScopeDescriptor(
  entry: Pick<AutomationHostCatalogEntry, 'querySupport' | 'scopeGap'>
): AutomationHostStatusDescriptor | null {
  if (entry.querySupport === 'scoped') {
    return null
  }
  if (entry.querySupport === 'incompatible') {
    return {
      id: 'query-incompatible',
      label: translate(
        'auto.components.automations.hostStatus.query.incompatible',
        'Update server'
      ),
      description: translate(
        'auto.components.automations.hostStatus.query.incompatibleDescription',
        'This server is too old to scope automations by host. Update it to manage automations here.'
      ),
      tone: 'attention',
      isDefault: false
    }
  }
  // An unscoped contract with no recorded cause can only be the authority's own.
  return scopeGapDescriptor(entry.scopeGap ?? 'authority-unscoped')
}
