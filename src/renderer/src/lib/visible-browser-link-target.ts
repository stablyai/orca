import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { getEffectiveLayoutForWorktree } from '@/components/terminal/split-group-mount'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/tab-group-layout-tree'
import { getGroupActiveTab } from '@/store/slices/editor/tabs/editor-open-target-group'

/** Optional maps: the link router's injected accessor and test stubs reach this before hydration. */
export type VisibleBrowserLinkState = {
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
  groupsByWorktree?: Record<string, TabGroup[]>
  unifiedTabsByWorktree?: Record<string, Tab[]>
  activeGroupIdByWorktree?: Record<string, string | undefined>
}

export type BrowserLinkPlacement = { targetGroupId: string }

/** The on-screen group whose active tab is a browser: focused group first, else most recently focused. */
export function findVisibleBrowserLinkTarget(
  state: VisibleBrowserLinkState,
  worktreeId: string
): BrowserLinkPlacement | undefined {
  const focusedGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  const layout = getEffectiveLayoutForWorktree(
    worktreeId,
    state.layoutByWorktree ?? {},
    state.groupsByWorktree ?? {},
    state.activeGroupIdByWorktree ?? {}
  )
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const tabsById = new Map((state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((t) => [t.id, t]))
  let best: Tab | undefined
  for (const groupId of collectLayoutGroupIds(layout)) {
    const group = groups.find((g) => g.id === groupId)
    const tab = group ? getGroupActiveTab(group, tabsById) : null
    if (!tab || tab.groupId !== groupId || tab.contentType !== 'browser') {
      continue
    }
    if (groupId === focusedGroupId) {
      return { targetGroupId: groupId }
    }
    if (!best || (tab.lastFocusedAt ?? 0) > (best.lastFocusedAt ?? 0)) {
      best = tab
    }
  }
  return best ? { targetGroupId: best.groupId } : undefined
}
