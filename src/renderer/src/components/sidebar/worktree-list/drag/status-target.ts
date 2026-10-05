import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import { getWorkspaceStatusFromGroupKey, getWorkspaceStatusGroupKey } from '../../workspace-status'
import { getWorktreeLineageDropTargetId } from '../../worktree-lineage-drag-drop'
import type { WorktreeSidebarStatusDropTarget } from '../../worktree-sidebar-drop-preview'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET, type WorktreeSidebarLineageDropTarget } from './row-state'

export function getPointerDropStatusTarget(args: {
  container: HTMLElement
  x: number
  y: number
}): WorktreeSidebarLineageDropTarget {
  const target = document.elementFromPoint(args.x, args.y)
  if (!(target instanceof Element) || !args.container.contains(target)) {
    return NO_WORKTREE_SIDEBAR_DROP_TARGET
  }
  const pinTarget = target.closest<HTMLElement>('[data-workspace-pin-drop-target]')
  if (pinTarget && args.container.contains(pinTarget)) {
    return { status: null, isPinDrop: true, lineageParentId: null }
  }
  const lineageParentId = getWorktreeLineageDropTargetId({
    container: args.container,
    target,
    pointerY: args.y
  })
  const statusTarget = target.closest<HTMLElement>('[data-workspace-status-drop-target]')
  const isContainedStatusTarget = statusTarget && args.container.contains(statusTarget)
  return {
    status: isContainedStatusTarget
      ? ((statusTarget.dataset.workspaceStatus as WorkspaceStatus | undefined) ?? null)
      : null,
    groupKey: isContainedStatusTarget
      ? (statusTarget.dataset.workspaceStatusGroupKey ?? null)
      : null,
    isPinDrop: false,
    lineageParentId
  }
}

type WorkspaceStatusGroupKeySegment = {
  start: number
  end: number
  status: WorkspaceStatus
}

function getWorkspaceStatusGroupKeySegment(
  groupKey: string,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatusGroupKeySegment | null {
  const primaryEnd = groupKey.indexOf('/')
  const primarySegment = primaryEnd === -1 ? groupKey : groupKey.slice(0, primaryEnd)
  const primaryStatus = getWorkspaceStatusFromGroupKey(primarySegment, workspaceStatuses)
  if (primaryStatus !== null) {
    return { start: 0, end: primarySegment.length, status: primaryStatus }
  }

  // Project identifiers may contain `/` and even status-like path segments. In
  // a two-level key, a secondary Status is always the final encoded segment.
  const marker = '/workspace-status:'
  const markerIndex = groupKey.lastIndexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  const start = markerIndex + 1
  const secondarySegment = groupKey.slice(start)
  const secondaryStatus = getWorkspaceStatusFromGroupKey(secondarySegment, workspaceStatuses)
  return secondaryStatus === null ? null : { start, end: groupKey.length, status: secondaryStatus }
}

export function getWorkspaceStatusTargetGroupKey(args: {
  sourceGroupKey: string
  status: WorkspaceStatus
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): string {
  const segment = getWorkspaceStatusGroupKeySegment(args.sourceGroupKey, args.workspaceStatuses)
  if (!segment) {
    return getWorkspaceStatusGroupKey(args.status)
  }
  return `${args.sourceGroupKey.slice(0, segment.start)}${getWorkspaceStatusGroupKey(args.status)}${args.sourceGroupKey.slice(segment.end)}`
}

export function shouldPreferSidebarStatusDropTarget(args: {
  sourceGroupKey: string
  target: WorktreeSidebarStatusDropTarget
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): boolean {
  if (args.target.isPinDrop) {
    return true
  }
  if (!args.target.status) {
    return false
  }
  // The DOM key is the exact rendered lane. Prefer it whenever it differs from
  // the source, including a Pinned source whose raw key has no Status segment.
  if (args.target.groupKey) {
    return args.target.groupKey !== args.sourceGroupKey
  }
  const sourceStatus = getWorkspaceStatusGroupKeySegment(
    args.sourceGroupKey,
    args.workspaceStatuses
  )?.status
  // Legacy targets have no DOM key, so retain the status-only fallback.
  return sourceStatus !== undefined && args.target.status !== sourceStatus
}
