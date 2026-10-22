import { useAppStore } from '@/store'
import type { CombinedDiffViewSuccession } from './combined-diff-view-cache'

function isOpenUnifiedTab(tabId: string): boolean {
  return Object.values(useAppStore.getState().unifiedTabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === tabId)
  )
}

/** Tab-scoped viewers inherit from closed tabs of the same diff; the unscoped legacy key is already stable. */
export function buildCombinedDiffViewTabSuccession(
  contentKey: string,
  viewStateScopeId: string | undefined
): CombinedDiffViewSuccession | undefined {
  if (viewStateScopeId === undefined || viewStateScopeId === contentKey) {
    return undefined
  }
  return { contentKey, scopeId: viewStateScopeId, isScopeOpen: isOpenUnifiedTab }
}
