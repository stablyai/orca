// Main lists locally owned workspace terminals in layout-owner builds; window reports shown/parked panes. Paired workspaces retain window lists.
import { getParkedTerminalWatcherPaneIdsByPtyId } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import type { AppState } from '@/store/types'
import type { RuntimeMountedLeaf } from '../../../../shared/runtime-types'

/** True when main, not this window, lists the workspace's terminals. An unclear owner keeps the
 *  window's list: main drops it for a workspace it does own. */
export function mainListsWorkspaceTerminals(
  state: Parameters<typeof runtimeEnvironmentIdForWorkspaceOwner>[0],
  worktreeId: string
): boolean {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  return owner.kind === 'resolved' && owner.environmentId === null
}

function addMountedLeaves(
  graph: { mountedLeaves?: RuntimeMountedLeaf[] },
  leaves: readonly RuntimeMountedLeaf[]
): void {
  graph.mountedLeaves = [...(graph.mountedLeaves ?? []), ...leaves]
}

/** The panes a mounted tab shows, by renderer pane id, with the titles the window resolved. */
export function addMountedPanes(
  graph: { mountedLeaves?: RuntimeMountedLeaf[] },
  tabId: string,
  panes: readonly { id: number; leafId: string }[],
  state: Pick<AppState, 'runtimePaneTitlesByTabId'>
): void {
  const paneTitles = state.runtimePaneTitlesByTabId[tabId] ?? {}
  addMountedLeaves(
    graph,
    panes.map((pane) => ({
      tabId,
      leafId: pane.leafId,
      paneRuntimeId: pane.id,
      paneTitle: paneTitles[pane.id] ?? null
    }))
  )
}

/** The panes of an unmounted tab a parked watcher keeps, numbered as the window's list numbers them. */
export function addParkedPanes(
  graph: { mountedLeaves?: RuntimeMountedLeaf[] },
  tabId: string,
  liveLeaves: readonly [leafId: string, ptyId: string][],
  state: Pick<AppState, 'runtimePaneTitlesByTabId'>
): void {
  const parkedPaneIdsByPtyId = getParkedTerminalWatcherPaneIdsByPtyId(tabId)
  const paneTitles = state.runtimePaneTitlesByTabId[tabId] ?? {}
  addMountedLeaves(
    graph,
    liveLeaves.map(([leafId, ptyId], index) => {
      const parkedPaneId = parkedPaneIdsByPtyId.get(ptyId)
      return {
        tabId,
        leafId,
        paneRuntimeId: parkedPaneId ?? index + 1,
        parked: true,
        paneTitle: (parkedPaneId === undefined ? null : paneTitles[parkedPaneId]) ?? null
      }
    })
  )
}
