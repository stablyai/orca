import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { getEffectiveLayoutForWorktree } from '@/components/terminal/split-group-mount'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'

type LinkTab = Pick<Tab, 'id'> &
  Partial<Pick<Tab, 'groupId' | 'contentType' | 'lastFocusedAt' | 'executionHostId'>>

type VisibleBrowserLinkState = {
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
  groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>
  unifiedTabsByWorktree?: Record<string, readonly LinkTab[]>
  activeGroupIdByWorktree?: Record<string, string | undefined>
}

export type BrowserLinkPlacement = { targetGroupId: string }

/** The focused visible browser wins, then the most recently focused, then layout order. */
export function findVisibleBrowserLinkTarget(
  state: VisibleBrowserLinkState,
  worktreeId: string,
  acceptsTab: (tab: LinkTab) => boolean = () => true
): BrowserLinkPlacement | undefined {
  const focusedGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  const layout = getEffectiveLayoutForWorktree(
    worktreeId,
    state.layoutByWorktree ?? {},
    state.groupsByWorktree ?? {},
    state.activeGroupIdByWorktree ?? {}
  )
  if (!layout) {
    return undefined
  }
  const groups = new Map((state.groupsByWorktree?.[worktreeId] ?? []).map((g) => [g.id, g]))
  const tabs = new Map((state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((t) => [t.id, t]))
  let best: { groupId: string; lastFocusedAt: number } | undefined
  for (const groupId of collectTabGroupLayoutGroupIds(layout)) {
    const activeTabId = groups.get(groupId)?.activeTabId
    const tab = activeTabId ? tabs.get(activeTabId) : undefined
    if (
      !tab ||
      (tab.groupId ?? groupId) !== groupId ||
      tab.contentType !== 'browser' ||
      !acceptsTab(tab)
    ) {
      continue
    }
    if (groupId === focusedGroupId) {
      return { targetGroupId: groupId }
    }
    const lastFocusedAt = tab.lastFocusedAt ?? 0
    if (!best || lastFocusedAt > best.lastFocusedAt) {
      best = { groupId, lastFocusedAt }
    }
  }
  return best ? { targetGroupId: best.groupId } : undefined
}
