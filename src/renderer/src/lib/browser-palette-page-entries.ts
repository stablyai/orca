import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isPaletteCurrentWorktree, resolvePaletteRepoForWorktree } from './palette-repo-resolution'
import {
  buildSearchableBrowserPageDocument,
  type SearchableBrowserPage
} from './browser-palette-search'

type BrowserPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator'

export type BuildSearchableBrowserPagesOptions = {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  repoMapByHostIdentity?: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  browserTabsByWorktree: Record<string, readonly BrowserWorkspace[] | undefined>
  browserPagesByWorkspace: Record<string, readonly BrowserPage[] | undefined>
  /** Source of browser recency: focus lives on the workspace's unified tab, not the page. */
  unifiedTabsByWorktree?: Record<string, readonly Tab[] | undefined>
  activeBrowserTabId: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeTabType: BrowserPaletteActiveTabType
}

export function buildSearchableBrowserPages({
  worktrees,
  repoMap,
  repoMapByHostIdentity,
  worktreeOrder,
  browserTabsByWorktree,
  browserPagesByWorkspace,
  unifiedTabsByWorktree,
  activeBrowserTabId,
  activeWorktreeId,
  activeWorkspaceExecutionHostId,
  activeTabType
}: BuildSearchableBrowserPagesOptions): SearchableBrowserPage[] {
  const entries: SearchableBrowserPage[] = []
  for (const worktree of worktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeSortIndex =
      worktreeOrder.get(getWorktreeHostIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const focusedAtByWorkspaceId = new Map<string, number>()
    for (const tab of unifiedTabsByWorktree?.[worktree.id] ?? []) {
      if (tab.contentType === 'browser' && tab.lastFocusedAt) {
        focusedAtByWorkspaceId.set(tab.entityId, tab.lastFocusedAt)
      }
    }
    for (const workspace of browserTabsByWorktree[worktree.id] ?? []) {
      const workspaceFocusedAt = focusedAtByWorkspaceId.get(workspace.id)
      for (const page of browserPagesByWorkspace[workspace.id] ?? []) {
        entries.push({
          page,
          workspace,
          worktree,
          repoName,
          worktreeSortIndex,
          isCurrentPage:
            isPaletteCurrentWorktree(worktree, activeWorktreeId, activeWorkspaceExecutionHostId) &&
            activeTabType === 'browser' &&
            workspace.id === activeBrowserTabId &&
            workspace.activePageId === page.id,
          isCurrentWorktree: isPaletteCurrentWorktree(
            worktree,
            activeWorktreeId,
            activeWorkspaceExecutionHostId
          ),
          // Never older than the page itself: it was opened while the workspace was focused.
          lastActiveAt: workspaceFocusedAt ? Math.max(workspaceFocusedAt, page.createdAt) : null,
          document: buildSearchableBrowserPageDocument({ page, workspace, worktree, repoName })
        })
      }
    }
  }
  return entries
}
