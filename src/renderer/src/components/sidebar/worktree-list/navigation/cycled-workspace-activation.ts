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
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type {
  KeybindingActionId,
  KeybindingOverrides
} from '../../../../../../shared/keybindings/types'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'
import { readBotSidebarCycleRows } from '@/components/bots/bot-sidebar-cycle-entries'
import { readSidebarRevealTarget } from '../../sidebar-reveal-target-state'
import type {
  LastActiveCycleWorkspace,
  LastActiveSectionWorkspaces,
  SidebarCycleScope,
  SidebarCycleSection
} from './worktree-keyboard-cycle'
import type { RenderedWorkspaceRow } from './worktree-sidebar-row-preference'

export type SidebarCycleShortcutMatch = {
  action: KeybindingActionId
  direction: 'up' | 'down'
  scope: SidebarCycleScope
}

const SIDEBAR_CYCLE_SHORTCUTS: readonly SidebarCycleShortcutMatch[] = [
  { action: 'worktree.navigateUp', direction: 'up', scope: 'section' },
  { action: 'worktree.navigateDown', direction: 'down', scope: 'section' },
  { action: 'worktree.navigateUpAll', direction: 'up', scope: 'all' },
  { action: 'worktree.navigateDownAll', direction: 'down', scope: 'all' }
]

export function matchSidebarCycleShortcut(
  event: KeyboardEvent,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): SidebarCycleShortcutMatch | null {
  for (const candidate of SIDEBAR_CYCLE_SHORTCUTS) {
    if (keybindingMatchesAction(candidate.action, event, platform, keybindings)) {
      return candidate
    }
  }
  return null
}

let cycleActivationEpoch = 0
const lastActiveBySection: LastActiveSectionWorkspaces = {}

export function readActiveSidebarCycleSection(): SidebarCycleSection | null {
  const section = readSidebarRevealTarget().section
  return section === 'bots' || section === 'projects' ? section : null
}

export function recordLastActiveSectionWorkspace(
  section: SidebarCycleSection | null,
  workspace: LastActiveCycleWorkspace
): void {
  if (section) {
    lastActiveBySection[section] = workspace
  }
}

export function readLastActiveSectionWorkspaces(): LastActiveSectionWorkspaces {
  return { ...lastActiveBySection }
}

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
      state.settings?.botsEnabled !== false &&
      state.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY),
    activeSection: readActiveSidebarCycleSection()
  }
}

export function activateAndRevealCycledRow(row: RenderedWorkspaceRow): void {
  const epoch = ++cycleActivationEpoch
  const targetExecutionHostId = getWorktreeExecutionHostId(row.worktree, row.repo)
  recordLastActiveSectionWorkspace(row.section === 'bots' ? 'bots' : 'projects', {
    worktreeId: row.worktree.id,
    executionHostId: targetExecutionHostId
  })
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
