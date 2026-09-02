/**
 * Adapts the renderer's `automationsChanged` window event to the invalidation
 * model's authority events.
 *
 * The publisher's authority is the environment it arrived from — desktop when
 * none is named. An event that carries no selector still invalidates that one
 * authority, which is what keeps an old host (or an unattributed local write)
 * refreshing rather than being dropped.
 */

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
