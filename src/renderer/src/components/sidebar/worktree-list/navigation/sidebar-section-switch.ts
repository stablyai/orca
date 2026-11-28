import { useAppStore } from '@/store'
import type { WorktreeNavHistoryEntry } from '@/store/slices/ui/workspace-navigation-history'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import {
  activateAndRevealCycledRow,
  readGlobalSidebarCycleOptions,
  readLastActiveSectionWorkspaces,
  readPendingBotGroupCycleRow
} from './cycled-workspace-activation'
import {
  composeSidebarCycleRows,
  dedupeCycleRows,
  getCyclableRowIdentity,
  resolveActiveCycleIdentity,
  resolveActiveSidebarSection,
  resolveCycleAnchorExecutionHostId,
  resolveCycleAnchorWorktreeId,
  type LastActiveCycleWorkspace,
  type LastActiveSectionWorkspaces,
  type SidebarCycleSection
} from './worktree-keyboard-cycle'
import {
  getRenderedWorkspaceRowsInSidebarOrder as getCyclableWorktreeRows,
  type RenderedWorkspaceRow
} from './worktree-sidebar-row-preference'

/** Resolve the target row when jumping between the Bots and Projects sidebar sections. */
export function resolveSwitchedSectionRow(args: {
  rows: readonly HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  botsRows: readonly RenderedWorkspaceRow[]
  projectsFirst?: boolean
  projectsCollapsed?: boolean
  activeSection?: SidebarCycleSection | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  lastActiveWorkspace: LastActiveCycleWorkspace | null
  lastActiveBySection: LastActiveSectionWorkspaces
  navHistory: readonly WorktreeNavHistoryEntry[]
  navHistoryIndex: number
}): RenderedWorkspaceRow | null {
  const visibleProjects = args.projectsCollapsed
    ? []
    : dedupeCycleRows(getCyclableWorktreeRows(args.rows, args.pinnedDisplayPolicy))
  const visibleBots = dedupeCycleRows(args.botsRows)
  const allRows = composeSidebarCycleRows({
    botsRows: visibleBots,
    projectsRows: visibleProjects,
    projectsFirst: args.projectsFirst ?? false,
    projectsCollapsed: args.projectsCollapsed ?? false
  })
  const anchorWorktreeId = resolveCycleAnchorWorktreeId({
    activeWorktreeId: args.activeWorktreeId,
    navHistory: args.navHistory,
    navHistoryIndex: args.navHistoryIndex,
    worktreeIds: allRows.map((row) => row.worktree.id)
  })
  const activeIdentity = resolveActiveCycleIdentity({
    rows: allRows,
    activeWorktreeId: anchorWorktreeId,
    activeWorkspaceExecutionHostId: resolveCycleAnchorExecutionHostId({
      anchorWorktreeId,
      activeWorktreeId: args.activeWorktreeId,
      activeWorkspaceExecutionHostId: args.activeWorkspaceExecutionHostId,
      lastActiveWorkspace: args.lastActiveWorkspace
    })
  })
  const currentSection = resolveActiveSidebarSection({
    botsRows: visibleBots,
    projectsRows: visibleProjects,
    activeIdentity,
    preferredSection: args.activeSection,
    projectsFirst: args.projectsFirst ?? false
  })
  if (currentSection === null) {
    return null
  }
  const targetSection: SidebarCycleSection = currentSection === 'bots' ? 'projects' : 'bots'
  const targetRows = targetSection === 'bots' ? visibleBots : visibleProjects
  if (targetRows.length === 0) {
    return null
  }
  const remembered = args.lastActiveBySection[targetSection]
  if (remembered) {
    const rememberedIdentity = resolveActiveCycleIdentity({
      rows: targetRows,
      activeWorktreeId: remembered.worktreeId,
      activeWorkspaceExecutionHostId: remembered.executionHostId
    })
    const matched = rememberedIdentity
      ? targetRows.find((row) => getCyclableRowIdentity(row) === rememberedIdentity)
      : undefined
    if (matched) {
      return matched
    }
  }
  return targetRows[0] ?? null
}

export function switchAndRevealSidebarSection(args: {
  rows: readonly HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  previewRow: RenderedWorkspaceRow | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  lastActiveWorkspace: LastActiveCycleWorkspace | null
  dropPreview: () => void
}): void {
  const { worktreeNavHistory, worktreeNavHistoryIndex } = useAppStore.getState()
  const anchorRow = args.previewRow ?? readPendingBotGroupCycleRow()
  const globalOptions = readGlobalSidebarCycleOptions()
  const targetRow = resolveSwitchedSectionRow({
    rows: args.rows,
    pinnedDisplayPolicy: args.pinnedDisplayPolicy,
    ...globalOptions,
    activeSection: anchorRow?.section ?? globalOptions.activeSection,
    activeWorktreeId: anchorRow?.worktree.id ?? args.activeWorktreeId,
    activeWorkspaceExecutionHostId: anchorRow
      ? getWorktreeExecutionHostId(anchorRow.worktree, anchorRow.repo)
      : args.activeWorkspaceExecutionHostId,
    lastActiveWorkspace: args.lastActiveWorkspace,
    lastActiveBySection: readLastActiveSectionWorkspaces(),
    navHistory: worktreeNavHistory,
    navHistoryIndex: worktreeNavHistoryIndex
  })
  if (!targetRow) {
    return
  }
  args.dropPreview()
  activateAndRevealCycledRow(targetRow)
}
