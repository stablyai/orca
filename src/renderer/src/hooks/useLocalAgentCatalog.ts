import { useEffect, useState } from 'react'
import type { LocalAgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import {
  applyLocalAgentCatalogSnapshot,
  getLocalAgentCatalogState,
  IDLE_LOCAL_AGENT_CATALOG_STATE,
  loadLocalAgentCatalog,
  subscribeToLocalAgentCatalog,
  type LocalAgentCatalogState
} from './local-agent-catalog-store'

export type UseLocalAgentCatalog = {
  /** Null while the first `getLocal` is in flight. */
  snapshot: LocalAgentCatalogSnapshot | null
  loading: boolean
  /** True when the local catalog surface does not exist here (paired web);
   *  callers render their read-only empty state instead of a loading spinner. */
  unavailable: boolean
  /** Re-read the local snapshot from the host (desktop preload IPC only). */
  refetch: () => void
  /** Adopt the authoritative snapshot a local mutation just returned, without a
   *  refetch round-trip. Supersedes any in-flight `getLocal`. */
  applySnapshot: (snapshot: LocalAgentCatalogSnapshot) => void
}

export type UseLocalAgentCatalogOptions = {
  /** False keeps a mounted-but-inert surface (a closed dialog) off the store:
   *  no fetch, no subscription, no snapshot. Defaults to true. */
  enabled?: boolean
}

/**
 * Live local agent-catalog snapshot for the Settings catalog UI (custom agents,
 * repair rows, projection/storage status). The catalog is desktop-local preload
 * IPC — never a runtime RPC — so this hook is only meaningful on the desktop host.
 *
 * Why: custom agents live in the local snapshot, not in `GlobalSettings`, so the
 * pane cannot derive them from the settings store. Default/disabled selection can
 * still change out-of-band (another window, menu), so we refetch on those narrow
 * settings slices to keep rows and the default picker consistent.
 *
 * Every consumer reads one shared fetch/cache/subscription (see
 * `local-agent-catalog-store`): a workspace with many split tab bars pays for a
 * single `getLocal` round-trip and one snapshot copy, not one per surface.
 */
export function useLocalAgentCatalog(options?: UseLocalAgentCatalogOptions): UseLocalAgentCatalog {
  const enabled = options?.enabled ?? true
  const [state, setState] = useState<LocalAgentCatalogState>(IDLE_LOCAL_AGENT_CATALOG_STATE)

  useEffect(() => {
    if (!enabled) {
      setState(IDLE_LOCAL_AGENT_CATALOG_STATE)
      return undefined
    }
    const sync = (): void => setState(getLocalAgentCatalogState())
    const unsubscribe = subscribeToLocalAgentCatalog(sync)
    // Adopt whatever the store already holds; a later consumer must not wait for
    // the next publish to see the snapshot an earlier one already loaded.
    sync()
    return unsubscribe
  }, [enabled])

  return {
    snapshot: state.snapshot,
    loading: enabled && state.snapshot === null && !state.unavailable,
    unavailable: state.unavailable,
    refetch: loadLocalAgentCatalog,
    applySnapshot: applyLocalAgentCatalogSnapshot
  }
}
