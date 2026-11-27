import type { StoreApi } from 'zustand'
import { isCompleteAgentInventoryKey } from '@/runtime/hosts/preflight/local-preflight-context-key'
import type { LocalAgentInventoryLifecycle } from './local-agent-inventory-refresh'
import { createEmptyLocalDetectedAgentState } from './local-detected-agent-store-state'
import type { AppState } from '../../types'

/** A dropped inventory's in-flight probes and failure flags predate the disabled list. */
function forgetEnabledContexts(keyed: Map<string, unknown> | Set<string>): void {
  for (const contextKey of keyed.keys()) {
    if (!isCompleteAgentInventoryKey(contextKey)) {
      keyed.delete(contextKey)
    }
  }
}

function keepCompleteInventories<T>(byContext: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(byContext).filter(([contextKey]) => isCompleteAgentInventoryKey(contextKey))
  )
}

/** A changed disabled list only re-filters the enabled inventories; the complete one does not depend on it. */
export function dropEnabledLocalAgentInventories(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  lifecycle: LocalAgentInventoryLifecycle
): void {
  const state = get()
  lifecycle.detectedContextKey = null
  lifecycle.legacyDetectContextKey = null
  lifecycle.legacyRefreshContextKey = null
  forgetEnabledContexts(lifecycle.detectPromises)
  forgetEnabledContexts(lifecycle.refreshPromises)
  forgetEnabledContexts(lifecycle.failedDetectContextKeys)
  forgetEnabledContexts(lifecycle.refusedContextKeys)
  set({
    ...createEmptyLocalDetectedAgentState(),
    localDetectedAgentIdsByContext: keepCompleteInventories(state.localDetectedAgentIdsByContext),
    // A kept inventory's probe is still running, so its loading flag stays with it.
    isDetectingLocalAgentsByContext: keepCompleteInventories(state.isDetectingLocalAgentsByContext),
    isRefreshingLocalAgentsByContext: keepCompleteInventories(
      state.isRefreshingLocalAgentsByContext
    )
  })
}
