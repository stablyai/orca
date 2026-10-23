import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { getEffectiveLayoutForWorktree } from '@/components/terminal/split-group-mount'
import { collectLayoutGroupIds } from '@/runtime/web-session-tabs-sync/tab-group-layout-tree'

// Only the fields read here, so the link router's partial test stores type-check.
type LinkTab = Pick<Tab, 'id' | 'groupId'> & Partial<Pick<Tab, 'contentType' | 'lastFocusedAt'>>

/** Optional maps: the link router's injected accessor and test stubs reach this before hydration. */
export type VisibleBrowserLinkState = {
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
  groupsByWorktree?: Record<string, TabGroup[]>
  unifiedTabsByWorktree?: Record<string, LinkTab[]>
  activeGroupIdByWorktree?: Record<string, string | undefined>
}

export type BrowserLinkPlacement = { targetGroupId: string }

export type BrowserLinkOpenerState = VisibleBrowserLinkState & {
  createBrowserTab: (
    worktreeId: string,
    url: string,
    opts: { activate: boolean; targetGroupId?: string }
  ) => unknown
  focusGroup?: (worktreeId: string, groupId: string) => void
}

/** Opens url in the on-screen browser group if there is one, else at createBrowserTab's default spot. */
export function openBrowserLinkInVisibleGroup(
  state: BrowserLinkOpenerState,
  worktreeId: string,
  url: string
): void {
  const placement = findVisibleBrowserLinkTarget(state, worktreeId)
  state.createBrowserTab(worktreeId, url, { activate: true, ...placement })
  if (placement) {
    state.focusGroup?.(worktreeId, placement.targetGroupId)
  }
}

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
  let best: LinkTab | undefined
  for (const groupId of collectLayoutGroupIds(layout)) {
    const group = groups.find((g) => g.id === groupId)
    const tab = group?.activeTabId ? tabsById.get(group.activeTabId) : undefined
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
