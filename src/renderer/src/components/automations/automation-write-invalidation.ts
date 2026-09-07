/**
 * Which host cache entry a local automation write must invalidate.
 *
 * The authority publishes its own `automationsChanged` event, but that is an IPC
 * round trip the user spends looking at the list they just changed — and it is
 * droppable, because the host a create lands on may have no cache entry yet. The
 * write already knows the host it addressed, so it feeds the same invalidation
 * in directly. A row whose owner was never captured names no host, and the whole
 * authority is invalidated rather than a guessed selector.
 */

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

/**
 * The host a listed row belongs to. Null when the row carried no owner metadata
 * at all: an authority that never qualified its rows cannot be asked which of
 * its hosts changed.
 */
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
  // Rebuilt per variant rather than spread: the stable ref drops the generation and the
  // orphan issue, and a widened `kind` would not discriminate.
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

/**
 * The invalidation a completed write owes, ready to feed to the host controller.
 * The reason is the caller's: a run rewrites history and the next-run projection
 * without touching the definition, and a subscriber that filters on it must not
 * be told otherwise.
 */
export function automationWriteChangeEvent(
  ref: StableAutomationCatalogRef | null,
  authority: AutomationAuthorityRef,
  reason: AutomationAuthorityChangeReason = 'definition'
): AutomationAuthorityChangeEvent {
  return ref
    ? { authority: ref.authority, selector: ref.selector, reason }
    : { authority: stableAutomationAuthorityRef(authority), reason }
}
