import { supersedeVirtualizedScrollAnchorRestore } from '@/lib/list-interaction/virtualized-scrolling/requestVirtualizedScrollAnchorRecord'
import { getSidebarRowRevealAncestorKeys } from './reveal-ancestors'
import type { WorktreeOccurrencePlan } from '../../../../../../shared/sidebar-list/lineage/worktree-occurrence-plan'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import type {
  PendingSidebarRowReveal,
  PendingSidebarWorktreeReveal
} from '@/store/slices/ui/ui-slice-contract-core'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { SidebarLineageParentIdentities } from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-projection'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { RenderRow } from '../listing/render-row'
import type { ProjectGroupingModel } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import { getFolderWorkspaceRevealGroupKeys, sidebarWorkspaceStillExists } from './folder-reveal'
import {
  findPreferredRenderRowIndexForWorktree,
  findPreferredRenderRowIndexForWorktreeIdentity,
  rowKeyMatchesRenderRow
} from './render-row-lookup'
import { narrowTagRevealKeys } from '../../../../../../shared/sidebar-list/sections/tag-groups'
import { getWorktreeRevealCollapsedGroupKeys } from './worktree-reveal-group-keys'
import { useAppStore } from '@/store'
import { indexHiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'
import { readSidebarWorkspaceOwner } from '../../sidebar-reveal-target-state'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { getActiveSidebarWorkspaceId } from '../../../../../../shared/workspace/identity/workspace-scope'

export const MAX_REVEAL_RETRIES = 8

export type PendingSidebarRevealArgs = {
  occurrencePlan?: WorktreeOccurrencePlan<Worktree>
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  clearPendingRevealWorktreeId: (expected?: PendingSidebarWorktreeReveal | null) => void
  clearPendingRevealSidebarRow: (expected?: PendingSidebarRowReveal | null) => void
  agentSendTargetWorktreeId: string | null
  renderRows: RenderRow[]
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  scrollRef: React.RefObject<HTMLDivElement | null>
  worktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repoMap: Map<string, Repo>
  worktreeMap: Map<string, Worktree>
  worktreeLineageById: Record<string, WorktreeLineage>
  lineageParentIdentities?: SidebarLineageParentIdentities
  collapsedGroups: Set<string>
  toggleGroup: (key: string) => void
  groupBy: WorktreeGroupBy
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  defaultHostId: ExecutionHostId
  prCache: AppState['prCache'] | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
  flashRevealedRow: (rowKey: string) => void
  markRevealScroll: (targetTop: number) => void
  schedulePendingRevealFrame: (callback: FrameRequestCallback) => void
  cancelPendingRevealFrames: () => void
}

export function expandGroupsForWorktreeReveal(
  args: PendingSidebarRevealArgs,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): void {
  const hostScopedGroups = args.renderRows.some(
    (row) => row.type === 'host-header' || (row.type === 'header' && row.collapseKey !== undefined)
  )
  const folderGroupKeys = getFolderWorkspaceRevealGroupKeys(
    worktreeId,
    args.folderWorkspaces,
    args.projectGroups,
    {
      groupBy: args.groupBy,
      workspaceStatuses: args.workspaceStatuses,
      defaultHostId: args.defaultHostId,
      hostScopedGroups,
      executionHostId
    }
  )
  if (folderGroupKeys.length > 0) {
    for (const groupKey of narrowTagRevealKeys(folderGroupKeys, args.collapsedGroups)) {
      if (args.collapsedGroups.has(groupKey)) {
        args.toggleGroup(groupKey)
      }
    }
    return
  }
  const targetWorktree = args.worktrees.find(
    (worktree) =>
      worktree.id === worktreeId &&
      (!executionHostId || !worktree.hostId || worktree.hostId === executionHostId)
  )
  if (!targetWorktree) {
    return
  }
  for (const groupKey of getWorktreeRevealCollapsedGroupKeys({
    ...args,
    worktree: targetWorktree,
    hostScopedGroups
  })) {
    args.toggleGroup(groupKey)
  }
}

/** A bot's home or worker line is the Bots section's row, never this list's: a reveal of it here
 *  would open repo groups for nothing and wait forever for a row that never renders. */
export function isPendingRevealOwnedOutsideProjects(
  request: PendingSidebarWorktreeReveal
): boolean {
  return (
    !request.rowKey &&
    readSidebarWorkspaceOwner(request.worktreeId, request.executionHostId).section !== 'projects'
  )
}

/** The open workspace's reveal (a notification opening a bot's run) goes to the Bots section, which
 *  scrolls to the line it already lists there. */
export function handPendingRevealToBots(request: PendingSidebarWorktreeReveal): void {
  const state = useAppStore.getState()
  if (
    request.rowKey ||
    getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId) !==
      request.worktreeId ||
    readSidebarWorkspaceOwner(request.worktreeId, request.executionHostId).section !== 'bots'
  ) {
    return
  }
  requestScrollToCurrentWorkspaceReveal({ highlight: request.highlight === true })
}

export function resolvePendingSidebarReveal(args: {
  targetIndex: number
  targetWorktreeStillExists: boolean
}): 'scroll-and-clear' | 'clear' | 'keep-pending' {
  if (args.targetIndex !== -1) {
    return 'scroll-and-clear'
  }
  return args.targetWorktreeStillExists ? 'keep-pending' : 'clear'
}

// A hidden project's rows never render, so waiting for one would hold the request until unhide.
function isRevealTargetInHiddenProject(
  worktrees: readonly Worktree[],
  defaultHostId: ExecutionHostId,
  request: PendingSidebarWorktreeReveal
): boolean {
  const target = worktrees.find(
    (worktree) =>
      worktree.id === request.worktreeId &&
      (!request.executionHostId || !worktree.hostId || worktree.hostId === request.executionHostId)
  )
  // The sidebar's own default host, so the reveal and the rows agree on unstamped rows.
  return (
    target !== undefined &&
    indexHiddenProjects(useAppStore.getState().repos, defaultHostId).isRowHidden({
      repoId: target.repoId,
      hostId: target.hostId ?? request.executionHostId
    })
  )
}

export function resolvePendingWorktreeRevealTarget(
  args: Pick<
    PendingSidebarRevealArgs,
    | 'renderRows'
    | 'worktrees'
    | 'folderWorkspaces'
    | 'pinnedDisplayPolicy'
    | 'defaultHostId'
    | 'agentSendTargetWorktreeId'
  >,
  request: PendingSidebarWorktreeReveal
): { targetIndex: number; outcome: 'scroll-and-clear' | 'clear' | 'keep-pending' } {
  // Send to agent forces its target into this list, a bot's worker included: that row is revealed
  // here like any other (the Projects section unfolds for it, the list scrolls to it).
  if (
    args.agentSendTargetWorktreeId !== request.worktreeId &&
    isPendingRevealOwnedOutsideProjects(request)
  ) {
    return { targetIndex: -1, outcome: 'clear' }
  }
  const rowKey = request.rowKey
  const targetIndex = rowKey
    ? args.renderRows.findIndex((row) => rowKeyMatchesRenderRow(row, rowKey))
    : request.executionHostId
      ? findPreferredRenderRowIndexForWorktreeIdentity(
          args.renderRows,
          { id: request.worktreeId, hostId: request.executionHostId },
          args.pinnedDisplayPolicy
        )
      : findPreferredRenderRowIndexForWorktree(
          args.renderRows,
          request.worktreeId,
          args.pinnedDisplayPolicy
        )
  const outcome = rowKey
    ? targetIndex === -1
      ? 'clear'
      : 'scroll-and-clear'
    : resolvePendingSidebarReveal({
        targetIndex,
        targetWorktreeStillExists:
          sidebarWorkspaceStillExists(
            request.worktreeId,
            args.worktrees,
            selectFolderWorkspaces(args),
            request.executionHostId
          ) && !isRevealTargetInHiddenProject(args.worktrees, args.defaultHostId, request)
      })
  return { targetIndex, outcome }
}

export function preparePendingSidebarRowReveal(
  args: PendingSidebarRevealArgs,
  request: PendingSidebarRowReveal
): boolean {
  const isProjectHeaderTarget =
    request.rowKey.startsWith('project-group:') ||
    request.rowKey.startsWith('project:') ||
    request.rowKey.startsWith('repo:')
  if (isProjectHeaderTarget && args.groupBy !== 'repo') {
    return false
  }

  supersedeVirtualizedScrollAnchorRestore(args.scrollRef.current)
  let toggledAncestor = false
  for (const groupKey of getSidebarRowRevealAncestorKeys({
    rowKey: request.rowKey,
    repoMap: args.repoMap,
    projectGroups: args.projectGroups,
    projectGrouping: args.projectGrouping
  })) {
    if (args.collapsedGroups.has(groupKey)) {
      args.toggleGroup(groupKey)
      toggledAncestor = true
    }
  }
  return !toggledAncestor
}
