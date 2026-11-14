import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { buildByIdIndex } from '../../../../../shared/first-row-by-id-index'
import { buildWorktreeByIdIndex } from './workspace-terminal-worktree-index'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from '../terminal-state'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'
import { markFullResync, recordDraft, tabBucketDraft } from '../../keyed-record-transitions'

export function createWorkspaceTerminalReconnectActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'reconnectPersistedTerminals'> {
  return {
    reconnectPersistedTerminals: async (signal) => {
      if (signal?.aborted) {
        return
      }
      const {
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        terminalLayoutsByTabId,
        tabsByWorktree,
        ptyIdsByTabId
      } = get()
      const ids = pendingReconnectWorktreeIds ?? []
      if (ids.length === 0) {
        set({
          workspaceSessionReady: true,
          pendingReconnectWorktreeIds: [],
          pendingReconnectTabByWorktree: {},
          // Cold path: the whole reconnect inventory is consumed.
          pendingReconnectPtyIdByTabId: markFullResync({}, 'reconnect-inventory')
        })
        return
      }
      // Why: defer daemon attachment for real dimensions; eager 80×24 flushes garble output.
      const reconnectedTabsByWorktree = tabBucketDraft(tabsByWorktree)
      const reconnectedPtyIdsByTabId = recordDraft(ptyIdsByTabId)
      // No writes/awaits in the loop, so one store-snapshot index serves every iteration.
      const worktreeById = buildWorktreeByIdIndex(selectWorktreesByRepo(get()))
      const repoById = buildByIdIndex(get().repos)
      for (const worktreeId of ids) {
        const tabs = tabsByWorktree[worktreeId] ?? []
        const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
        const tabById = targetTabIds.length > 1 ? buildByIdIndex(tabs) : null
        const tabsToReconnect: TerminalTab[] =
          targetTabIds.length > 0
            ? targetTabIds
                .map((id) => (tabById ? tabById.get(id) : tabs.find((t) => t.id === id)))
                .filter((t): t is TerminalTab => t != null)
            : tabs.slice(0, 1)
        if (tabsToReconnect.length === 0) {
          continue
        }
        for (const tab of tabsToReconnect) {
          const tabId = tab.id
          const layout = terminalLayoutsByTabId[tabId]
          const leafPtyMap = layout?.ptyIdsByLeafId ?? {}
          const tabLevelPtyId = pendingReconnectPtyIdByTabId[tabId]
          const hasLeafMappings = Object.keys(leafPtyMap).length > 0
          // Advertise leaf PTYs before mount so daemon sessions do not look orphaned; subsumed rows may lack tab.ptyId but retain leaf bindings.
          const allPtyIds = hasLeafMappings
            ? (Object.values(leafPtyMap).filter(Boolean) as string[])
            : tabLevelPtyId
              ? [tabLevelPtyId]
              : []
          if (allPtyIds.length > 0) {
            // Why: hide-sleeping reads ptyIdsByTabId for liveness; restored daemon sessions run before their pane remounts, so advertise them.
            reconnectedPtyIdsByTabId.set(tabId, allPtyIds)
          }
          if (tabLevelPtyId) {
            const nextTabs = reconnectedTabsByWorktree.get(worktreeId)
            if (!nextTabs) {
              continue
            }
            reconnectedTabsByWorktree.set(
              worktreeId,
              nextTabs.map((t) => (t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t))
            )
          }
        }
      }
      // Why: keep deferred SSH session IDs for post-cleanup reconnect.
      const deferredSshSessionIdsByTabId: Record<string, string> = {}
      for (const worktreeId of ids) {
        const worktree = worktreeById.get(worktreeId)
        // Cold-start SSH listings are absent; derive repo ID from the composite worktree ID to retain deferred sessions.
        const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
        const repo = repoId ? (repoById.get(repoId) ?? null) : null
        const connectionId = repo?.connectionId
        if (!connectionId) {
          continue
        }
        // Only a hydrated target catalog proves removal; re-deferring absent targets creates permanent orphan-sweep liveness (#9911).
        if (get().sshTargetsHydrated && !get().sshTargetLabels.has(connectionId)) {
          continue
        }
        const sshConnected = get().sshConnectionStates.get(connectionId)?.status === 'connected'
        if (sshConnected) {
          continue
        }
        const tabs = tabsByWorktree[worktreeId] ?? []
        for (const tab of tabs) {
          const sessionId = pendingReconnectPtyIdByTabId[tab.id]
          if (sessionId) {
            deferredSshSessionIdsByTabId[tab.id] = sessionId
          }
        }
      }
      if (signal?.aborted) {
        return
      }
      const nextTabsByWorktree = reconnectedTabsByWorktree.finish()
      const nextPtyIdsByTabId = reconnectedPtyIdsByTabId.finish()
      set({
        // Only each row's ptyId changes, a field the frame merge leaves to the window.
        ...(nextTabsByWorktree !== tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
        ...(nextPtyIdsByTabId !== ptyIdsByTabId ? { ptyIdsByTabId: nextPtyIdsByTabId } : {}),
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {},
        // Cold path: the whole reconnect inventory is consumed.
        pendingReconnectPtyIdByTabId: markFullResync({}, 'reconnect-inventory'),
        deferredSshSessionIdsByTabId
      })
    }
  }
}
