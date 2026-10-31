import type { WorktreeOccurrencePlan } from '../../../../../../shared/worktree-occurrence-plan'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { PendingSidebarRowReveal, PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RenderRow } from '../listing/render-row'
import type { ProjectGroupingModel } from '../../../../../../shared/project-section-grouping'
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
import { getWorktreeRevealCollapsedGroupKeys } from './worktree-reveal-group-keys'

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
    for (const groupKey of folderGroupKeys) {
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

export function resolvePendingSidebarReveal(args: {
  targetIndex: number
  targetWorktreeStillExists: boolean
}): 'scroll-and-clear' | 'clear' | 'keep-pending' {
  if (args.targetIndex !== -1) {
    return 'scroll-and-clear'
  }
  return args.targetWorktreeStillExists ? 'keep-pending' : 'clear'
}

export function resolvePendingWorktreeRevealTarget(
  args: Pick<
    PendingSidebarRevealArgs,
    'renderRows' | 'worktrees' | 'folderWorkspaces' | 'pinnedDisplayPolicy'
  >,
  request: PendingSidebarWorktreeReveal
) {
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
        targetWorktreeStillExists: sidebarWorkspaceStillExists(
          request.worktreeId,
          args.worktrees,
          selectFolderWorkspaces(args),
          request.executionHostId
        )
      })
  return { targetIndex, outcome }
}
