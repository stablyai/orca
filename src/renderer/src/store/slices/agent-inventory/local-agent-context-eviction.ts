import type { AppState } from '../../types'
import type { LocalAgentInventoryLifecycle } from './local-agent-inventory-refresh'

type LocalAgentContextState = Pick<
  AppState,
  | 'detectedAgentIds'
  | 'isDetectingAgents'
  | 'isRefreshingAgents'
  | 'localDetectedAgentIdsByContext'
  | 'isDetectingLocalAgentsByContext'
  | 'isRefreshingLocalAgentsByContext'
  | 'pathSource'
  | 'pathFailureReason'
>

export type LocalAgentContextEviction = {
  removedContextKeys: ReadonlySet<string>
  detectedContextKey: string | null
  legacyDetectContextKey: string | null
  legacyRefreshContextKey: string | null
  statePatch: Partial<LocalAgentContextState>
}

export function removeLocalAgentContextEntries<T>(
  entries: Record<string, T>,
  contextKeys: ReadonlySet<string>
): Record<string, T> {
  let filtered = entries
  for (const contextKey of contextKeys) {
    if (!(contextKey in filtered)) {
      continue
    }
    if (filtered === entries) {
      filtered = { ...entries }
    }
    delete filtered[contextKey]
  }
  return filtered
}

export function removeLocalAgentContextEntry<T>(entries: Record<string, T>, contextKey: string) {
  return removeLocalAgentContextEntries(entries, new Set([contextKey]))
}

/** Every context the store or the lifecycle tracks, cached or in flight. */
export function getTrackedLocalAgentContextKeys(
  state: LocalAgentContextState,
  lifecycle: LocalAgentInventoryLifecycle
): Set<string> {
  return new Set([
    ...Object.keys(state.localDetectedAgentIdsByContext),
    ...Object.keys(state.isDetectingLocalAgentsByContext),
    ...Object.keys(state.isRefreshingLocalAgentsByContext),
    ...lifecycle.detectPromises.keys(),
    ...lifecycle.refreshPromises.keys(),
    ...lifecycle.failedDetectContextKeys,
    ...lifecycle.refusedContextKeys
  ])
}

export function getLocalAgentContextEviction(
  state: LocalAgentContextState,
  lifecycle: LocalAgentInventoryLifecycle,
  shouldRemove: (contextKey: string) => boolean
): LocalAgentContextEviction | null {
  const removedContextKeys = new Set(
    [...getTrackedLocalAgentContextKeys(state, lifecycle)].filter(shouldRemove)
  )
  if (removedContextKeys.size === 0) {
    return null
  }
  const isRemoved = (contextKey: string | null): boolean =>
    contextKey !== null && removedContextKeys.has(contextKey)
  const clearDetected =
    isRemoved(lifecycle.detectedContextKey) || isRemoved(lifecycle.legacyDetectContextKey)
  const clearRefreshing = isRemoved(lifecycle.legacyRefreshContextKey)
  return {
    removedContextKeys,
    detectedContextKey: isRemoved(lifecycle.detectedContextKey)
      ? null
      : lifecycle.detectedContextKey,
    legacyDetectContextKey: isRemoved(lifecycle.legacyDetectContextKey)
      ? null
      : lifecycle.legacyDetectContextKey,
    legacyRefreshContextKey: isRemoved(lifecycle.legacyRefreshContextKey)
      ? null
      : lifecycle.legacyRefreshContextKey,
    statePatch: {
      ...(clearDetected
        ? {
            detectedAgentIds: null,
            isDetectingAgents: false,
            pathSource: null,
            pathFailureReason: null
          }
        : {}),
      ...(clearRefreshing ? { isRefreshingAgents: false } : {}),
      localDetectedAgentIdsByContext: removeLocalAgentContextEntries(
        state.localDetectedAgentIdsByContext,
        removedContextKeys
      ),
      isDetectingLocalAgentsByContext: removeLocalAgentContextEntries(
        state.isDetectingLocalAgentsByContext,
        removedContextKeys
      ),
      isRefreshingLocalAgentsByContext: removeLocalAgentContextEntries(
        state.isRefreshingLocalAgentsByContext,
        removedContextKeys
      )
    }
  }
}

/** Forgets the evicted contexts' probes, so a late result cannot restore them. */
export function applyLocalAgentContextEviction(
  lifecycle: LocalAgentInventoryLifecycle,
  eviction: LocalAgentContextEviction
): void {
  for (const contextKey of eviction.removedContextKeys) {
    lifecycle.detectPromises.delete(contextKey)
    lifecycle.refreshPromises.delete(contextKey)
    lifecycle.failedDetectContextKeys.delete(contextKey)
    lifecycle.refusedContextKeys.delete(contextKey)
  }
  lifecycle.detectedContextKey = eviction.detectedContextKey
  lifecycle.legacyDetectContextKey = eviction.legacyDetectContextKey
  lifecycle.legacyRefreshContextKey = eviction.legacyRefreshContextKey
}
