import type { AppState } from '@/store'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

type TerminalTabWindowDetachStore = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'groupsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'repos'
  | 'worktreesByRepo'
>

/**
 * Snapshot a tab and its live layout for a whole-tab-to-window detach. Pure —
 * the caller still owns removing the tab from the strip (via `closeTab` with
 * `localPtyTeardownOwnedExternally: true`, which keeps the PTY alive while
 * running the same side-table cleanup a normal close does).
 */
export function captureTerminalTabForWindowDetach(
  store: TerminalTabWindowDetachStore,
  worktreeId: string,
  tabId: string
): DetachedTerminalTabSeed | null {
  const tab = store.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  if (!tab) {
    return null
  }

  const group = store.groupsByWorktree[worktreeId]?.find((candidate) =>
    candidate.tabOrder.includes(tabId)
  )
  if (!group) {
    return null
  }

  const layout = store.terminalLayoutsByTabId[tabId] ?? null
  if (!layout) {
    return null
  }

  const ptyIds = store.ptyIdsByTabId[tabId] ?? []
  const ptyId = ptyIds.at(-1) ?? tab.ptyId ?? null

  // Derive repoId from worktreeId for the popout store's terminal route resolver.
  const separatorIdx = worktreeId.indexOf('::')
  const repoId = separatorIdx === -1 ? worktreeId : worktreeId.slice(0, separatorIdx)
  const repo = store.repos.find((r) => r.id === repoId)
  const worktree = (store.worktreesByRepo[repoId] ?? []).find((w) => w.id === worktreeId)
  if (!repo || !worktree) {
    return null
  }

  return {
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
      addedAt: repo.addedAt
    },
    worktree: { id: worktree.id, repoId: worktree.repoId, displayName: worktree.displayName }
  }
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
