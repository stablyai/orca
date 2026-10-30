import { normalizeCompatibleLifecycleEvent } from './compatible-lifecycle-events'
import type { HookListenerState } from '../listener-state'

export function normalizeQoderEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
) {
  return normalizeCompatibleLifecycleEvent(
    'qoder',
    state,
    eventName,
    promptText,
    paneKey,
    hookPayload
  )
}
