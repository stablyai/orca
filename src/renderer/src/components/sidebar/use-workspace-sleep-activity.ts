import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import {
  EMPTY_AGENT_STATUS_BY_PANE_KEY,
  EMPTY_BROWSER_TABS_BY_WORKTREE,
  EMPTY_PTY_IDS_BY_TAB_ID,
  EMPTY_STRUCTURED_CHAT_SLEPT_AT,
  EMPTY_TABS_BY_WORKTREE,
  EMPTY_UNIFIED_TABS_BY_WORKTREE,
  selectMenuScopedMap
} from './worktree-context-menu-policy'
import {
  hasSleepableWorkspaceActivity,
  type WorkspaceActivityMaps
} from './workspace-lineage-menu-actions'

/**
 * Live activity that decides whether a workspace can be slept.
 *
 * Why scoped to the menu: these maps churn constantly, and a closed menu has no
 * reader for them.
 */
export function useWorkspaceSleepActivity(args: {
  menuOpen: boolean
  activeContextWorktrees: readonly Worktree[]
}): { sleepActivity: WorkspaceActivityMaps; sleepableWorktrees: Worktree[] } {
  const { activeContextWorktrees, menuOpen } = args
  const tabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.tabsByWorktree, EMPTY_TABS_BY_WORKTREE)
  )
  const ptyIdsByTabId = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.ptyIdsByTabId, EMPTY_PTY_IDS_BY_TAB_ID)
  )
  const browserTabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.browserTabsByWorktree, EMPTY_BROWSER_TABS_BY_WORKTREE)
  )
  const unifiedTabsByWorktree = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.unifiedTabsByWorktree, EMPTY_UNIFIED_TABS_BY_WORKTREE)
  )
  const agentStatusByPaneKey = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.agentStatusByPaneKey, EMPTY_AGENT_STATUS_BY_PANE_KEY)
  )
  const structuredChatSleptAtByPaneKey = useAppStore((s) =>
    selectMenuScopedMap(menuOpen, s.structuredChatSleptAtByPaneKey, EMPTY_STRUCTURED_CHAT_SLEPT_AT)
  )
  const sleepActivity = useMemo(
    () => ({
      tabsByWorktree,
      ptyIdsByTabId,
      browserTabsByWorktree,
      unifiedTabsByWorktree,
      agentStatusByPaneKey,
      structuredChatSleptAtByPaneKey
    }),
    [
      agentStatusByPaneKey,
      browserTabsByWorktree,
      structuredChatSleptAtByPaneKey,
      ptyIdsByTabId,
      tabsByWorktree,
      unifiedTabsByWorktree
    ]
  )
  const sleepableWorktrees = useMemo(
    () =>
      activeContextWorktrees.filter((item) =>
        hasSleepableWorkspaceActivity(item.id, sleepActivity)
      ),
    [activeContextWorktrees, sleepActivity]
  )
  return { sleepActivity, sleepableWorktrees }
}
