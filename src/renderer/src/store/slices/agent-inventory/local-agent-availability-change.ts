import {
  filterEnabledTuiAgents,
  normalizeDisabledTuiAgents
} from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import {
  completeLocalAgentInventoryKey,
  enabledOnlyLocalAgentInventoryKey,
  isCompleteLocalAgentInventoryKey
} from '@/runtime/hosts/preflight/local-preflight-context-key'
import {
  applyLocalAgentContextEviction,
  getLocalAgentContextEviction,
  getTrackedLocalAgentContextKeys,
  removeLocalAgentContextEntries
} from './local-agent-context-eviction'
import type { LocalAgentInventoryLifecycle } from './local-agent-inventory-refresh'
import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

function haveSameIds(a: readonly TuiAgent[], b: readonly TuiAgent[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function readUsableInventory(
  cached: AppState['localDetectedAgentIdsByContext'],
  lifecycle: LocalAgentInventoryLifecycle,
  contextKey: string
): TuiAgent[] | null {
  const ids = cached[contextKey]
  return ids != null &&
    !lifecycle.failedDetectContextKeys.has(contextKey) &&
    !lifecycle.refusedContextKeys.has(contextKey) &&
    !lifecycle.keptThroughFailure.has(ids)
    ? ids
    : null
}

/** Folds a successful enabled-only probe into the cached complete inventory, so a re-enable can trust it. */
export function mergeEnabledProbeIntoCompleteInventory(
  state: Pick<AppState, 'localDetectedAgentIdsByContext' | 'settings'>,
  lifecycle: LocalAgentInventoryLifecycle,
  enabledOnlyKey: string,
  found: readonly TuiAgent[]
): Record<string, TuiAgent[]> {
  const completeKey = completeLocalAgentInventoryKey(enabledOnlyKey)
  const complete = readUsableInventory(state.localDetectedAgentIdsByContext, lifecycle, completeKey)
  // A timed-out WSL scan reports nothing found, which must not erase installed agents.
  if (!complete || found.length === 0) {
    return {}
  }
  // The probe skipped disabled agents, so only their entries keep the older result.
  const disabled = new Set(normalizeDisabledTuiAgents(state.settings?.disabledTuiAgents))
  const merged = [
    ...complete.filter((id) => disabled.has(id) || found.includes(id)),
    ...found.filter((id) => !complete.includes(id))
  ]
  return haveSameIds(merged, complete) ? {} : { [completeKey]: merged }
}

/**
 * Updates enabled-only inventories in place on a toggle instead of re-probing them. Re-enabled
 * agents come from a usable complete inventory; without one, or after a failed probe, the context
 * is dropped for a re-probe. Returns the dropped contexts.
 */
export function applyLocalAgentAvailabilityChange(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  lifecycle: LocalAgentInventoryLifecycle,
  previousDisabled: unknown
): ReadonlySet<string> {
  const state = get()
  const cached = state.localDetectedAgentIdsByContext
  const disabled = state.settings?.disabledTuiAgents
  const stillDisabled = new Set(normalizeDisabledTuiAgents(disabled))
  const reEnabled = new Set(
    normalizeDisabledTuiAgents(previousDisabled).filter((id) => !stillDisabled.has(id))
  )
  const usable = (contextKey: string): TuiAgent[] | null =>
    readUsableInventory(cached, lifecycle, contextKey)
  const reconcile = (contextKey: string): TuiAgent[] | null => {
    // A failed or refused probe stays dropped until it is probed again.
    if (
      lifecycle.failedDetectContextKeys.has(contextKey) ||
      lifecycle.refusedContextKeys.has(contextKey)
    ) {
      return null
    }
    const complete = usable(completeLocalAgentInventoryKey(contextKey))
    const fromComplete = complete && filterEnabledTuiAgents(complete, disabled)
    if (cached[contextKey] == null) {
      return fromComplete
    }
    const current = usable(contextKey)
    if (!current || (reEnabled.size > 0 && !fromComplete)) {
      return null
    }
    const kept = filterEnabledTuiAgents(current, disabled)
    if (!fromComplete) {
      return haveSameIds(kept, current) ? current : kept
    }
    // Order by the complete inventory, so a re-enabled agent returns to its place.
    const ids = [
      ...fromComplete.filter((id) => kept.includes(id) || reEnabled.has(id)),
      ...kept.filter((id) => !fromComplete.includes(id))
    ]
    return haveSameIds(ids, current) ? current : ids
  }

  const next: Record<string, TuiAgent[]> = {}
  const stripped = new Set<string>()
  const evict = new Set<string>()
  for (const contextKey of getTrackedLocalAgentContextKeys(state, lifecycle)) {
    if (isCompleteLocalAgentInventoryKey(contextKey)) {
      continue
    }
    const ids = reconcile(contextKey)
    // A running complete refresh owns this key and re-filters on resolve, so keep its probe.
    if (lifecycle.refreshPromises.has(completeLocalAgentInventoryKey(contextKey))) {
      if (ids && ids !== cached[contextKey]) {
        next[contextKey] = ids
      } else if (!ids && cached[contextKey] != null) {
        stripped.add(contextKey)
      }
      continue
    }
    // A probe sent with the old disabled list would overwrite the reconciled list.
    if (
      !ids ||
      lifecycle.detectPromises.has(contextKey) ||
      lifecycle.refreshPromises.has(contextKey)
    ) {
      evict.add(contextKey)
    }
    if (ids && (ids !== cached[contextKey] || evict.has(contextKey))) {
      next[contextKey] = ids
    }
  }

  const legacyOwner =
    lifecycle.legacyRefreshContextKey ??
    lifecycle.legacyDetectContextKey ??
    lifecycle.detectedContextKey
  const ownerKey = legacyOwner && enabledOnlyLocalAgentInventoryKey(legacyOwner)
  const previousDetectedContextKey = lifecycle.detectedContextKey
  const eviction =
    evict.size > 0
      ? getLocalAgentContextEviction(state, lifecycle, (contextKey) => evict.has(contextKey))
      : null
  if (eviction) {
    applyLocalAgentContextEviction(lifecycle, eviction)
  }
  const patch: Partial<AppState> = { ...eviction?.statePatch }
  const ownerEvicted = legacyOwner !== null && evict.has(legacyOwner)
  if (ownerEvicted || eviction?.statePatch.detectedAgentIds === null) {
    const ownerIds = ownerKey ? next[ownerKey] : undefined
    if (ownerKey && ownerIds) {
      const sameOwner = ownerKey === previousDetectedContextKey
      lifecycle.detectedContextKey = ownerKey
      patch.detectedAgentIds = ownerIds
      patch.pathSource = sameOwner ? state.pathSource : null
      patch.pathFailureReason = sameOwner ? state.pathFailureReason : null
    } else if (ownerEvicted) {
      lifecycle.detectedContextKey = null
      patch.detectedAgentIds = null
      patch.pathSource = null
      patch.pathFailureReason = null
    }
  } else if (lifecycle.detectedContextKey !== null && lifecycle.detectedContextKey === ownerKey) {
    // Another context's pending probe owns the mirror until it publishes.
    const detectedKey = lifecycle.detectedContextKey
    if (next[detectedKey]) {
      patch.detectedAgentIds = next[detectedKey]
    } else if (stripped.has(detectedKey)) {
      lifecycle.detectedContextKey = null
      patch.detectedAgentIds = null
    }
  }
  if (Object.keys(next).length > 0 || stripped.size > 0) {
    patch.localDetectedAgentIdsByContext = {
      ...removeLocalAgentContextEntries(
        eviction?.statePatch.localDetectedAgentIdsByContext ?? cached,
        stripped
      ),
      ...next
    }
  }
  if (Object.keys(patch).length > 0) {
    set(patch)
  }
  return new Set([...evict].filter((contextKey) => !Object.hasOwn(next, contextKey)))
}
