/**
 * The host a refused action's recovery verb has to act on.
 *
 * A notice is raised where the user was working, which is not where the host
 * filter points: a row action addresses that row's captured owner, and a create
 * addresses the destination the dialog captured. Without this, Reconnect dials
 * and Update server opens settings for whichever host the list happens to be
 * scoped to — or, under All hosts, for nothing at all.
 */

import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import { automationRowCatalogRef } from './automation-write-invalidation'

export function automationRowRecoveryHost(
  catalog: AutomationHostCatalog,
  captured: AutomationCapturedOwner,
  authority: AutomationAuthorityRef
): AutomationHostCatalogEntry | null {
  const ref = automationRowCatalogRef(captured, authority)
  return ref ? (catalog.byStableKey.get(hostStableKey(ref)) ?? null) : null
}
