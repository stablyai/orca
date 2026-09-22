/**
 * Builds the fetch target a manual retry needs.
 *
 * The controller derives these itself for scheduled work; a user-initiated
 * Retry has to name one entry, and it must carry the same incarnation the
 * scheduler would have used or the response cannot commit.
 */

import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFetchTarget } from './automation-host-scheduler'

export function automationHostAuthorityRef(
  entry: AutomationHostCatalogEntry,
  pairingRevision: (environmentId: string) => number
): AutomationAuthorityRef {
  if (entry.owner) {
    return entry.owner.authority
  }
  const authority = entry.stableRef.authority
  return authority.kind === 'desktop'
    ? { kind: 'desktop' }
    : {
        kind: 'runtime',
        environmentId: authority.environmentId,
        pairingRevision: pairingRevision(authority.environmentId)
      }
}

export function automationHostFetchTarget(
  entry: AutomationHostCatalogEntry,
  pairingRevision: (environmentId: string) => number
): AutomationHostFetchTarget {
  return {
    ref: entry.stableRef,
    authority: automationHostAuthorityRef(entry, pairingRevision),
    owner: entry.owner,
    querySupport: entry.querySupport,
    // A retry is always what the user is waiting on, so it jumps the queue.
    priority: true
  }
}
