import { openBotGroup } from '@/lib/bot-group-catalog'
import { activateWorktreeFromSidebar } from '@/lib/workspace/activation/sidebar-worktree-activation'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
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

type PendingBotGroupOrigin = {
  worktreeId: string | null
  executionHostId: ExecutionHostId | null
  activeView: AppState['activeView']
  activeWorkspaceKey: AppState['activeWorkspaceKey']
  worktreeNavHistory: AppState['worktreeNavHistory']
  worktreeNavHistoryIndex: AppState['worktreeNavHistoryIndex']
}

type PendingBotGroupCycleTarget = {
  epoch: number
  row: RenderedWorkspaceRow
  origin: PendingBotGroupOrigin
}

let pendingBotGroupCycleTarget: PendingBotGroupCycleTarget | null = null

function readPendingBotGroupOrigin(): PendingBotGroupOrigin {
  const state = useAppStore.getState()
  return {
    ...readCurrentSidebarWorkspace(),
    activeView: state.activeView,
    activeWorkspaceKey: state.activeWorkspaceKey,
    worktreeNavHistory: state.worktreeNavHistory,
    worktreeNavHistoryIndex: state.worktreeNavHistoryIndex
  }
}

function matchesPendingBotGroupOrigin(origin: PendingBotGroupOrigin): boolean {
  const state = useAppStore.getState()
  const current = readCurrentSidebarWorkspace()
  return (
    origin.worktreeId === current.worktreeId &&
    origin.executionHostId === current.executionHostId &&
    origin.activeView === state.activeView &&
    origin.activeWorkspaceKey === state.activeWorkspaceKey &&
    origin.worktreeNavHistory === state.worktreeNavHistory &&
    origin.worktreeNavHistoryIndex === state.worktreeNavHistoryIndex
  )
}

export function readPendingBotGroupCycleRow(): RenderedWorkspaceRow | null {
  if (!pendingBotGroupCycleTarget) {
    return null
  }
  if (!matchesPendingBotGroupOrigin(pendingBotGroupCycleTarget.origin)) {
    pendingBotGroupCycleTarget = null
    return null
  }
  return pendingBotGroupCycleTarget.row
}

export function clearPendingBotGroupCycleRow(): void {
  pendingBotGroupCycleTarget = null
}

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
    pendingBotGroupCycleTarget = {
      epoch,
      row,
      origin: readPendingBotGroupOrigin()
    }
    void openBotGroup(row.botGroup, {
      shouldActivate: () => epoch === cycleActivationEpoch,
      onActivated: () => requestScrollToCurrentWorkspaceReveal({ highlight: false })
    })
      .catch(console.error)
      .finally(() => {
        if (pendingBotGroupCycleTarget?.epoch === epoch) {
          pendingBotGroupCycleTarget = null
        }
      })
    return
  }
  pendingBotGroupCycleTarget = null
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
