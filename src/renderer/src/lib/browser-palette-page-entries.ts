import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
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
    for (const workspace of browserTabsByWorktree[worktree.id] ?? []) {
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
          document: buildSearchableBrowserPageDocument({ page, workspace, worktree, repoName })
        })
      }
    }
  }
  return entries
}
