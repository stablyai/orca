import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { AppState } from '@/store/types'
import type { PendingSidebarRowReveal, PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host'
import type { RenderRow } from '../listing/render-row'
import { getWorktreeLineageGroupKey } from '../grouping/group-keys'
import type { ProjectGroupingModel } from '../grouping/project-grouping'
import type { PinnedWorktreeDisplayPolicy, WorktreeGroupBy } from '../grouping/row-types'
import { getGroupKeysForWorktree } from '../grouping/worktree-group-keys'
import { isPinnedSectionWorktree } from '../../pinned-section-worktrees'
import { getWorktreeLineageAncestors } from '../../worktree-lineage-projection'
import { getFolderWorkspaceRevealGroupKeys } from './folder-reveal'
import { getPinnedWorktreeRevealCollapsedGroupKeys } from './reveal-ancestors'

export const MAX_REVEAL_RETRIES = 8

export type PendingSidebarRevealArgs = {
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  clearPendingRevealWorktreeId: () => void
  clearPendingRevealSidebarRow: () => void
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

// Expand whatever collapsed section hides the reveal target, then scroll to it.
export function expandGroupsForWorktreeReveal(
  args: PendingSidebarRevealArgs,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): void {
  const folderGroupKeys = getFolderWorkspaceRevealGroupKeys(
    worktreeId,
    args.folderWorkspaces,
    args.projectGroups,
    {
      groupBy: args.groupBy,
      workspaceStatuses: args.workspaceStatuses,
      defaultHostId: args.defaultHostId
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
  const targetRepo = args.repoMap.get(targetWorktree.repoId)
  const hostGroupKey = `host:${getWorktreeExecutionHostId(targetWorktree, targetRepo, args.defaultHostId)}`
  if (args.collapsedGroups.has(hostGroupKey)) {
    args.toggleGroup(hostGroupKey)
  }

  const hostWorktreeMap = new Map<string, Worktree>()
  const hostLineageById: Record<string, WorktreeLineage> = {}
  for (const worktree of args.worktrees) {
    if (executionHostId && worktree.hostId && worktree.hostId !== executionHostId) {
      continue
    }
    hostWorktreeMap.set(worktree.id, worktree)
    const projected = args.worktreeLineageById[worktree.id]
    const inline = (worktree as Worktree & { lineage?: WorktreeLineage | null }).lineage
    const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
    if (lineage) {
      hostLineageById[worktree.id] = lineage
    }
  }
  for (const parent of getWorktreeLineageAncestors(
    targetWorktree,
    hostLineageById,
    hostWorktreeMap
  )) {
    const lineageGroupKey = getWorktreeLineageGroupKey(parent)
    if (args.collapsedGroups.has(lineageGroupKey)) {
      args.toggleGroup(lineageGroupKey)
    }
  }

  const groupKeys =
    args.pinnedDisplayPolicy === 'single-location' &&
    isPinnedSectionWorktree(
      targetWorktree,
      args.worktrees,
      args.worktreeLineageById,
      args.worktreeMap
    )
      ? getPinnedWorktreeRevealCollapsedGroupKeys({
          worktree: targetWorktree,
          collapsedGroups: args.collapsedGroups,
          inPinnedSection: true
        })
      : getGroupKeysForWorktree(
          args.groupBy,
          targetWorktree,
          args.repoMap,
          args.prCache,
          args.workspaceStatuses,
          args.settings,
          args.projectGroups,
          args.projectGrouping
        )
  for (const groupKey of groupKeys) {
    if (args.collapsedGroups.has(groupKey)) {
      args.toggleGroup(groupKey)
    }
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
