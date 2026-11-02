/** Resolve publisher authority from its environment, defaulting to desktop; missing selectors still invalidate that authority for old-host/local-write compatibility. */

import {
  AUTOMATIONS_CHANGED_EVENT,
  automationsChangedWindowDetail,
  type AutomationsChangedWindowDetail
} from '@/lib/automations-changed-window-event'
import type { StableAutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationAuthorityChangeEvent } from './automation-host-invalidation'

export function toAutomationAuthorityChangeEvent(
  detail: AutomationsChangedWindowDetail
): AutomationAuthorityChangeEvent {
  const authority: StableAutomationAuthorityRef = detail.environmentId
    ? { kind: 'runtime', environmentId: detail.environmentId }
    : { kind: 'desktop' }
  return {
    authority,
    ...(detail.selector ? { selector: detail.selector } : {}),
    ...(detail.reason ? { reason: detail.reason } : {})
  }
}

export function subscribeAutomationHostInvalidation(
  handle: (event: AutomationAuthorityChangeEvent) => void,
  target: EventTarget = window
): () => void {
  const listener = (event: Event): void => {
    handle(toAutomationAuthorityChangeEvent(automationsChangedWindowDetail(event)))
  }
  target.addEventListener(AUTOMATIONS_CHANGED_EVENT, listener)
  return () => target.removeEventListener(AUTOMATIONS_CHANGED_EVENT, listener)
}
