import type { AppState } from '@/store/types'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type { MobileSessionWorktreeInputs } from './types'
import { isUnifiedTabActiveInActiveGroup } from './mobile-session-surfaces'

export function buildMobileBrowserTab(
  inputs: MobileSessionWorktreeInputs,
  workspace: NonNullable<AppState['browserTabsByWorktree'][string]>[number],
  unifiedTab?: Tab
): RuntimeMobileSessionBrowserTab {
  const pages = inputs.pagesByBrowserWorkspaceId.get(workspace.id) ?? []
  const activePage = pages.find((page) => page.id === workspace.activePageId) ?? pages[0] ?? null
  const title =
    activePage?.title || workspace.title || activePage?.url || workspace.url || 'Browser'
  const unifiedTabId = unifiedTab?.id
  return {
    type: 'browser',
    id: unifiedTabId ?? workspace.id,
    title,
    browserWorkspaceId: workspace.id,
    browserPageId: activePage?.id ?? workspace.activePageId ?? null,
    url: activePage?.url ?? workspace.url ?? 'about:blank',
    loading: activePage?.loading ?? workspace.loading,
    canGoBack: activePage?.canGoBack ?? workspace.canGoBack,
    canGoForward: activePage?.canGoForward ?? workspace.canGoForward,
    // Null means the active page cleared its failure; do not resurrect a stale workspace error.
    loadError: activePage ? activePage.loadError : workspace.loadError,
    certificateFailure: activePage
      ? (inputs.certificateFailureByBrowserPageId.get(activePage.id) ?? null)
      : null,
    color: unifiedTab?.color ?? null,
    isPinned: unifiedTab?.isPinned === true,
    isActive: unifiedTabId
      ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
      : inputs.activeBrowserWorkspaceId === workspace.id
  }
}
