import type { AppState } from '@/store'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

type TerminalTabWindowDetachStore = Pick<
  AppState,
  'tabsByWorktree' | 'groupsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId' | 'repos'
>

type DetachedTerminalTabSeedRecord = Omit<DetachedTerminalTabSeed, 'additionalTabs'>

/**
 * Snapshot the selected tabs and their live layouts for a whole-tab-to-window
 * detach. Pure — the caller still owns removing the tabs from the strip (via
 * `closeTab` with `localPtyTeardownOwnedExternally: true`, which keeps the PTYs
 * alive while running the same side-table cleanup a normal close does).
 */

export function captureTerminalTabForWindowDetach(
  store: TerminalTabWindowDetachStore,
  worktreeId: string,
  tabId: string,
  additionalTabIds?: string[]
): DetachedTerminalTabSeed | null {
  // Derive repoId from worktreeId for the popout store's terminal route resolver.
  const separatorIdx = worktreeId.indexOf('::')
  const repoId = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  const repo = store.repos.find((r) => r.id === repoId)
  if (!repo) {
    return null
  }

  const capturedTabs: DetachedTerminalTabSeedRecord[] = []
  const requestedTabIds = [tabId, ...(additionalTabIds ?? [])]
  for (const requestedTabId of requestedTabIds) {
    const tab = store.tabsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === requestedTabId
    )
    if (!tab) {
      return null
    }

    const group = store.groupsByWorktree[worktreeId]?.find((candidate) =>
      candidate.tabOrder.includes(requestedTabId)
    )
    if (!group) {
      return null
    }

    const layout = store.terminalLayoutsByTabId[requestedTabId] ?? null
    if (!layout) {
      return null
    }

    const ptyIds = store.ptyIdsByTabId[requestedTabId] ?? []
    const ptyId = ptyIds.at(-1) ?? tab.ptyId ?? null

    capturedTabs.push({
      worktreeId,
      groupId: group.id,
      tab,
      layout,
      ptyId,
      repo: {
        id: repo.id,
        path: repo.path,
        displayName: repo.displayName,
        badgeColor: repo.badgeColor,
        addedAt: repo.addedAt,
        connectionId: repo.connectionId ?? null,
        executionHostId: repo.executionHostId ?? null
      }
    })
  }

  const primary = capturedTabs[0]
  if (!primary) {
    return null
  }
  const additionalTabs = capturedTabs.slice(1)
  return additionalTabs.length > 0 ? { ...primary, additionalTabs } : primary
}

type TerminalTabWindowReintegrateStore = Pick<
  AppState,
  | 'groupsByWorktree'
  | 'createTab'
  | 'setTabLayout'
  | 'setActiveTab'
  | 'setTabCustomTitle'
  | 'setTabColor'
>

/**
 * Re-insert a previously detached tab using the same primitives the in-app
 * "drag a pane into a new tab" flow uses (`createTab` + `setTabLayout`) —
 * shared by both reintegration paths (explicit button and native window
 * close), since both arrive here with the same seed shape.
 */
export function reintegrateDetachedTerminalTab(
  store: TerminalTabWindowReintegrateStore,
  seed: DetachedTerminalTabSeed
): void {
  const targetGroupId = store.groupsByWorktree[seed.worktreeId]?.some(
    (candidate) => candidate.id === seed.groupId
  )
    ? seed.groupId
    : undefined

  store.createTab(seed.worktreeId, targetGroupId, seed.tab.shellOverride, {
    id: seed.tab.id,
    initialPtyId: seed.ptyId ?? undefined
  })
  store.setTabLayout(seed.tab.id, seed.layout)
  if (seed.tab.customTitle) {
    store.setTabCustomTitle(seed.tab.id, seed.tab.customTitle)
  }
  if (seed.tab.color) {
    store.setTabColor(seed.tab.id, seed.tab.color)
  }
  store.setActiveTab(seed.tab.id)
}
