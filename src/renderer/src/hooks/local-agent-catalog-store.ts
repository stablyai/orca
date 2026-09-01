// One process-wide local agent-catalog cache behind `useLocalAgentCatalog`.
// Every mounted consumer (each split group's tab bar, the composer, quick-command
// and automation dialogs, the settings pane) used to own a full `getLocal` IPC
// round-trip, a private snapshot copy, and its own settings subscription — at a
// 2,500-agent catalog that is megabytes of structured clone per surface. They now
// share this store: one fetch, one cached snapshot, one settings listener.

import type { GlobalSettings } from '../../../shared/types'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'

export type LocalAgentCatalogState = {
  /** Null while the first `getLocal` is in flight. */
  snapshot: LocalAgentCatalogSnapshot | null
  /** True when the local catalog surface does not exist here (paired web). */
  unavailable: boolean
}

/** Also the disabled-consumer state, so an opted-out caller never allocates. */
export const IDLE_LOCAL_AGENT_CATALOG_STATE: LocalAgentCatalogState = {
  snapshot: null,
  unavailable: false
}

let state: LocalAgentCatalogState = IDLE_LOCAL_AGENT_CATALOG_STATE
let requestToken = 0
let unsubscribeSettings: (() => void) | null = null
const listeners = new Set<() => void>()

function publish(next: LocalAgentCatalogState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

/** Re-read the local snapshot from the host (desktop preload IPC only). */
export function loadLocalAgentCatalog(): void {
  const getLocal = window.api?.settings?.agentCatalog?.getLocal
  if (typeof getLocal !== 'function') {
    // Host without the catalog preload surface: report unavailable rather than
    // throwing out of the subscribing effect and taking the surface down with it.
    publish({ snapshot: state.snapshot, unavailable: true })
    return
  }
  const token = (requestToken += 1)
  void window.api.settings.agentCatalog
    .getLocal()
    .then((next) => {
      if (token === requestToken) {
        publish({ snapshot: next, unavailable: false })
      }
    })
    .catch(() => {
      // Paired web rejects (not_available_on_paired_web): surface an honest
      // read-only empty state rather than a perpetual loading spinner.
      if (token === requestToken) {
        publish({ snapshot: state.snapshot, unavailable: true })
      }
    })
}

/** Adopt the authoritative snapshot a local mutation just returned, without a
 *  refetch round-trip. Supersedes any in-flight `getLocal`. */
export function applyLocalAgentCatalogSnapshot(next: LocalAgentCatalogSnapshot): void {
  requestToken += 1
  publish({ snapshot: next, unavailable: state.unavailable })
}

function handleSettingsChanged(updates: Partial<GlobalSettings>): void {
  // Custom-agent mutations patch customTuiAgents/deletedCustomTuiAgents (and
  // bump agentCatalogRevision); without these keys, always-mounted launch
  // surfaces keep a stale snapshot after authoring in another component.
  if (
    'defaultTuiAgent' in updates ||
    'disabledTuiAgents' in updates ||
    'customTuiAgents' in updates ||
    'deletedCustomTuiAgents' in updates ||
    'agentCatalogRevision' in updates
  ) {
    loadLocalAgentCatalog()
  }
}

export function subscribeToLocalAgentCatalog(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    // Same defensive read as `loadLocalAgentCatalog`: a host without the settings
    // change feed must degrade to a one-shot read, not throw out of the effect.
    const onChanged = window.api?.settings?.onChanged
    unsubscribeSettings = typeof onChanged === 'function' ? onChanged(handleSettingsChanged) : null
    loadLocalAgentCatalog()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) {
      return
    }
    unsubscribeSettings?.()
    unsubscribeSettings = null
    // With no listener there is no change feed, so a retained snapshot could go
    // silently stale; drop it (and orphan any in-flight load) so the next mount
    // reads fresh rather than painting a catalog edited while nothing watched.
    requestToken += 1
    state = IDLE_LOCAL_AGENT_CATALOG_STATE
  }
}

export function getLocalAgentCatalogState(): LocalAgentCatalogState {
  return state
}
