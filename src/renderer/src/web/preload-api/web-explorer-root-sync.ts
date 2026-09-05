import type { PreloadApi } from '../../../../preload/api-types'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import { readJson, writeJson } from './web-storage'
import { callRuntimeResult } from './web-runtime-calls'

type Roots = NonNullable<PairedUiState['explorerDisplayRootByWorktree']>
type Updates = Parameters<PreloadApi['ui']['set']>[0]
const PENDING_ROOTS_KEY = 'orca.web.pendingExplorerRoots.v1'

export function createWebExplorerRootSync() {
  const capableHosts = new Set<string>()
  const latestPrepared = new Map<string, Roots>()
  const pending = () => readJson<Record<string, Roots>>(PENDING_ROOTS_KEY, {})
  const acknowledge = (environmentId: string, roots: Roots) => {
    const queued = pending()
    if (JSON.stringify(queued[environmentId]) === JSON.stringify(roots)) {
      delete queued[environmentId]
      writeJson(PENDING_ROOTS_KEY, queued)
    }
  }
  return {
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
    acknowledge(environmentId: string | undefined, updates: Updates): void {
      if (environmentId && updates.explorerDisplayRootByWorktree !== undefined) {
        acknowledge(environmentId, updates.explorerDisplayRootByWorktree)
      }
    },
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
