/** Invalidate immediately from the completed write’s known host instead of waiting for a droppable change event. Uncaptured rows invalidate their authority without guessing a selector. */

import { toStableCatalogRef } from '../../../../shared/automation-owner-key'
import type {
  AutomationAuthorityRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import type {
  AutomationAuthorityChangeEvent,
  AutomationAuthorityChangeReason
} from './automation-host-invalidation'

export function stableAutomationAuthorityRef(
  authority: AutomationAuthorityRef
): StableAutomationAuthorityRef {
  return authority.kind === 'desktop'
    ? { kind: 'desktop' }
    : { kind: 'runtime', environmentId: authority.environmentId }
}

/** Return null without captured metadata; an unqualified row cannot identify which authority host changed. */
export function automationRowCatalogRef(
  captured: AutomationCapturedOwner,
  authority: AutomationAuthorityRef
): StableAutomationCatalogRef | null {
  if (captured.owner) {
    return toStableCatalogRef(captured.owner)
  }
  if (!captured.selector) {
    return null
  }
  const stable = stableAutomationAuthorityRef(authority)
  // Rebuild selector variants so kind stays discriminated while dropping generation/orphan-issue details.
  switch (captured.selector.kind) {
    case 'ssh':
      return {
        authority: stable,
        selector: { kind: 'ssh', targetId: captured.selector.targetId }
      }
    case 'orphan':
      return { authority: stable, selector: { kind: 'orphan' } }
    case 'self':
      return { authority: stable, selector: { kind: 'self' } }
  }
}

/** Preserve the write reason: run changes history/next-run projection without changing its definition, and subscribers may filter on that distinction. */
export function automationWriteChangeEvent(
  ref: StableAutomationCatalogRef | null,
  authority: AutomationAuthorityRef,
  reason: AutomationAuthorityChangeReason = 'definition'
): AutomationAuthorityChangeEvent {
  return ref
    ? { authority: ref.authority, selector: ref.selector, reason }
    : { authority: stableAutomationAuthorityRef(authority), reason }
}
