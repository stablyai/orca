import type { BrowserPage, BrowserWorkspace, Worktree } from '../../../shared/types'
import type { SearchableBrowserPage } from './browser-palette-search'

type BrowserPaletteActiveTabType = 'browser' | 'editor' | 'terminal' | 'simulator'

export type BuildSearchableBrowserPagesOptions = {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  browserTabsByWorktree: Record<string, readonly BrowserWorkspace[] | undefined>
  browserPagesByWorkspace: Record<string, readonly BrowserPage[] | undefined>
  activeBrowserTabId: string | null
  activeWorktreeId: string | null
  activeTabType: BrowserPaletteActiveTabType
}

export function buildSearchableBrowserPages({
  worktrees,
  repoMap,
  worktreeOrder,
  browserTabsByWorktree,
  browserPagesByWorkspace,
  activeBrowserTabId,
  activeWorktreeId,
  activeTabType
}: BuildSearchableBrowserPagesOptions): SearchableBrowserPage[] {
  const entries: SearchableBrowserPage[] = []
  for (const worktree of worktrees) {
    const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
    const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
    for (const workspace of browserTabsByWorktree[worktree.id] ?? []) {
      for (const page of browserPagesByWorkspace[workspace.id] ?? []) {
        entries.push({
          page,
          workspace,
          worktree,
          repoName,
          worktreeSortIndex,
          isCurrentPage:
            activeTabType === 'browser' &&
            workspace.id === activeBrowserTabId &&
            workspace.activePageId === page.id,
          isCurrentWorktree: activeWorktreeId === worktree.id
        })
      }
    }
  }
  return entries
}
