/** Recover against the refused row’s captured owner or create destination; the list filter may point elsewhere or to All hosts. */

import { hostStableKey } from '../../../../shared/automations/ownership/automation-owner-key'
import type { AutomationAuthorityRef } from '../../../../shared/automations/ownership/automation-owner-ref'
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
