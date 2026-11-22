import { openBotGroup } from '@/lib/bot-group-catalog'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'
import { readBotSidebarCycleRows } from '@/components/bots/bot-sidebar-cycle-entries'
import { readSidebarRevealTarget } from '../../sidebar-reveal-target-state'
import type { RenderedWorkspaceRow } from './worktree-sidebar-row-preference'

let cycleActivationEpoch = 0

export function readCurrentSidebarWorkspace(): {
  worktreeId: string | null
  executionHostId: ExecutionHostId | null
} {
  const state = useAppStore.getState()
  return {
    worktreeId:
      state.activeView === 'tasks' || state.activeView === 'activity'
        ? null
        : getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId),
    executionHostId: state.activeWorkspaceExecutionHostId
  }
}

export function readGlobalSidebarCycleOptions() {
  const state = useAppStore.getState()
  return {
    botsRows: readBotSidebarCycleRows(state.collapsedGroups, getIndexedRepoMap(state.repos)),
    projectsFirst: state.sidebarProjectsFirst,
    projectsCollapsed:
      state.settings?.botsEnabled !== false && state.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY)
  }
}

export function activateAndRevealCycledRow(row: RenderedWorkspaceRow): void {
  const epoch = ++cycleActivationEpoch
  if (row.botGroup) {
    void openBotGroup(row.botGroup, {
      shouldActivate: () => epoch === cycleActivationEpoch,
      onActivated: () => requestScrollToCurrentWorkspaceReveal({ highlight: false })
    }).catch(console.error)
    return
  }
  const executionHostId = getWorktreeExecutionHostId(row.worktree, row.repo)
  void activateWorktreeFromSidebar(row.worktree.id, executionHostId, {
    revealInSidebar: false
  })
  if (row.section === 'bots') {
    if (readSidebarRevealTarget().section === 'bots') {
      requestScrollToCurrentWorkspaceReveal({ highlight: false })
    } else {
      useAppStore.getState().revealWorktreeInSidebar(row.worktree.id, {
        behavior: 'auto',
        executionHostId
      })
    }
    return
  }
  useAppStore.getState().revealWorktreeInSidebar(row.worktree.id, {
    behavior: 'auto',
    executionHostId,
    rowKey: row.rowKey
  })
}
