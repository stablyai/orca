/** Renderer-internal fan-out for authority `automationsChanged` events, so the
 *  Automations page refreshes without every publisher knowing about the page. */
import type { AutomationsChangedPayload } from '../../../shared/runtime-client-events'

export const AUTOMATIONS_CHANGED_EVENT = 'orca:automations-changed'

/** `environmentId` names the runtime authority that published; absent means desktop. */
export type AutomationsChangedWindowDetail = AutomationsChangedPayload & {
  environmentId?: string | null
}

export function emitAutomationsChangedWindowEvent(
  detail: AutomationsChangedWindowDetail = {}
): void {
  window.dispatchEvent(
    new CustomEvent<AutomationsChangedWindowDetail>(AUTOMATIONS_CHANGED_EVENT, { detail })
  )
}

/** Missing or malformed detail degrades to an unscoped desktop event, never a dropped one. */
export function automationsChangedWindowDetail(event: Event): AutomationsChangedWindowDetail {
  const detail = (event as CustomEvent<unknown>).detail
  return detail && typeof detail === 'object' ? (detail as AutomationsChangedWindowDetail) : {}
}
