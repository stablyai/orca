import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { floatingWorkspaceToWorktree } from '../../../../../shared/floating-workspace-worktree'
import { workspaceBrowserTabs } from '@/store/slices/browser/tabs/workspace-browser-tabs'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab, WorkspaceVisibleTabType } from '../../../../../shared/tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import {
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from '../../workspace/search/palette-repo-resolution'
import {
  buildSearchableBrowserPageDocument,
  type SearchableBrowserPage
} from './browser-palette-search'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from '../../workspace/ownership/unified-tab-host-ownership'
import { maxValidPaletteActivityTimestamp } from '../../../../../shared/palette-match/palette-ranking'

export type BuildSearchableBrowserPagesOptions = {
  worktrees: readonly Worktree[]
  ownershipWorktrees?: readonly Pick<Worktree, 'id'>[]
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
  activeTabType: WorkspaceVisibleTabType
}

/** Index browser pages by their visible workspace placement while retaining source-owned records. */
export function buildSearchableBrowserPages({
  worktrees,
  ownershipWorktrees,
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
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees ?? worktrees)
  const allUnifiedTabs = Object.values(unifiedTabsByWorktree ?? {}).flatMap((tabs) => tabs ?? [])
  const duplicateTabIds = findDuplicateIds(allUnifiedTabs)
  const duplicateWorkspaceIds = findDuplicateIds(
    allUnifiedTabs
      .filter((tab) => tab.contentType === 'browser')
      .map((tab) => ({ id: tab.entityId }))
  )
  const duplicateStoredWorkspaceIds = findDuplicateIds(
    Object.values(browserTabsByWorktree).flatMap((workspaces) => workspaces ?? [])
  )
  const floatingTabs = unifiedTabsByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const placementWorktrees =
    floatingTabs.some((tab) => tab.contentType === 'browser') &&
    !worktrees.some((worktree) => worktree.id === FLOATING_TERMINAL_WORKTREE_ID)
      ? [...worktrees, floatingWorkspaceToWorktree('')]
      : worktrees
  for (const worktree of placementWorktrees) {
    const repoName =
      resolvePaletteRepoForWorktree(worktree, repoMap, repoMapByHostIdentity)?.displayName ?? ''
    const worktreeSortIndex =
      worktreeOrder.get(getPaletteWorktreeIdentity(worktree)) ??
      worktreeOrder.get(worktree.id) ??
      Number.MAX_SAFE_INTEGER
    const unifiedBrowserTabsByWorkspaceId = new Map<string, Tab>()
    const focusedAtByWorkspaceId = new Map<string, number>()
    const unifiedTabs = unifiedTabsByWorktree?.[worktree.id] ?? []
    for (const tab of unifiedTabs) {
      if (tab.contentType === 'browser' && !unifiedBrowserTabsByWorkspaceId.has(tab.entityId)) {
        unifiedBrowserTabsByWorkspaceId.set(tab.entityId, tab)
      }
      if (
        tab.contentType === 'browser' &&
        isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds) &&
        tab.lastFocusedAt
      ) {
        focusedAtByWorkspaceId.set(tab.entityId, tab.lastFocusedAt)
      }
    }
    for (const workspace of workspaceBrowserTabs(browserTabsByWorktree, worktree.id, unifiedTabs)) {
      if (
        duplicateWorkspaceIds.has(workspace.id) ||
        duplicateStoredWorkspaceIds.has(workspace.id)
      ) {
        continue
      }
      const candidate = unifiedBrowserTabsByWorkspaceId.get(workspace.id)
      if (
        !candidate &&
        allUnifiedTabs.some(
          (tab) =>
            tab.contentType === 'browser' &&
            tab.entityId === workspace.id &&
            tab.worktreeId !== worktree.id
        )
      ) {
        continue
      }
      const unifiedTab =
        candidate && isUnifiedTabOwnedByWorktree(candidate, worktree, ambiguousWorktreeIds)
          ? candidate
          : undefined
      if (!unifiedTab && (candidate || ambiguousWorktreeIds.has(worktree.id))) {
        continue
      }
      if (unifiedTab && duplicateTabIds.has(unifiedTab.id)) {
        continue
      }
      const workspaceFocusedAt = focusedAtByWorkspaceId.get(workspace.id)
      const pages = browserPagesByWorkspace[workspace.id] ?? []
      const duplicatePageIds = findDuplicateIds(pages)
      for (const page of pages) {
        if (
          duplicatePageIds.has(page.id) ||
          page.workspaceId !== workspace.id ||
          page.worktreeId !== workspace.worktreeId
        ) {
          continue
        }
        entries.push({
          page,
          workspace,
          worktree,
          repoName,
          worktreeSortIndex,
          executionHostId: getUnifiedTabPaletteExecutionHostId(unifiedTab, worktree),
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
          // Workspace focus is a lossy proxy for only its currently active page.
          lastFocusedAt: workspace.activePageId === page.id ? workspaceFocusedAt : undefined,
          lastActiveAt:
            workspace.activePageId === page.id && workspaceFocusedAt
              ? maxValidPaletteActivityTimestamp([workspaceFocusedAt, page.createdAt])
              : maxValidPaletteActivityTimestamp([page.createdAt]),
          document: buildSearchableBrowserPageDocument({ page, workspace, worktree, repoName })
        })
      }
    }
  }
  return entries
}
