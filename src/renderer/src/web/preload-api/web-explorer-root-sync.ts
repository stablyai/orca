import type { PreloadApi } from '../../../../preload/api-types'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import { readJson, writeJson } from './web-storage'
import { callRuntimeResult } from './web-runtime-calls'

type Roots = NonNullable<PairedUiState['explorerDisplayRootByWorktree']>
type Updates = Parameters<PreloadApi['ui']['set']>[0]
const PENDING_ROOTS_KEY = 'orca.web.pendingExplorerRoots.v1'

/** Queues explorer-root writes per host until supported and acknowledged, surviving hydration and browser reloads. */
export function createWebExplorerRootSync() {
  const capableHosts = new Set<string>()
  const latestPrepared = new Map<string, Roots>()
  /** Reads the durable queue on demand so acknowledgments consider writes made since the request began. */
  const pending = () => readJson<Record<string, Roots>>(PENDING_ROOTS_KEY, {})
  /** Removes only the matching queued snapshot, preserving a newer preference written during the request. */
  const acknowledge = (environmentId: string, roots: Roots) => {
    const queued = pending()
    if (JSON.stringify(queued[environmentId]) === JSON.stringify(roots)) {
      delete queued[environmentId]
      writeJson(PENDING_ROOTS_KEY, queued)
    }
  }
  return {
    /** Queues a host-scoped preference before stripping unsupported fields from the outgoing update. */
    prepare(environmentId: string | undefined, updates: Updates): void {
      const roots = updates.explorerDisplayRootByWorktree
      if (environmentId && roots !== undefined) {
        latestPrepared.set(environmentId, roots)
        writeJson(PENDING_ROOTS_KEY, { ...pending(), [environmentId]: roots })
      }
      if (!environmentId || !capableHosts.has(environmentId)) {
        delete updates.explorerDisplayRootByWorktree
      }
    },
    /** Acknowledges explorer roots only when they were included in the successful host update. */
    acknowledge(environmentId: string | undefined, updates: Updates): void {
      if (environmentId && updates.explorerDisplayRootByWorktree !== undefined) {
        acknowledge(environmentId, updates.explorerDisplayRootByWorktree)
      }
    },
    /** Learns host support and replays queued roots before hydration, retaining any newer edit made during replay. */
    async read(environmentId: string | undefined, ui: PairedUiState): Promise<void> {
      if (!environmentId) {
        return
      }
      if (ui.explorerDisplayRootByWorktree === undefined) {
        capableHosts.delete(environmentId)
        return
      }
      capableHosts.add(environmentId)
      const roots = pending()[environmentId]
      if (roots === undefined) {
        return
      }
      const preparedAtRead = latestPrepared.get(environmentId)
      // Replay survives hydration and browser reloads, even if the diff baseline became clean.
      await callRuntimeResult('ui.set', { explorerDisplayRootByWorktree: roots }, 15_000)
      acknowledge(environmentId, roots)
      const newerPrepared = latestPrepared.get(environmentId)
      ui.explorerDisplayRootByWorktree =
        newerPrepared && newerPrepared !== preparedAtRead
          ? newerPrepared
          : (pending()[environmentId] ?? roots)
    }
  }
}
