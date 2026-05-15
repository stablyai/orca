import type React from 'react'
import { Circle, CircleCheckBig, CircleDot, GitPullRequest } from 'lucide-react'
import type { WorkspaceStatus } from '../../../../shared/types'
import {
  DEFAULT_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUSES,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId
} from '../../../../shared/workspace-statuses'

export {
  DEFAULT_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUSES,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId
}

export const WORKSPACE_STATUS_DRAG_TYPE = 'application/x-orca-worktree-id'

export const DEFAULT_WORKSPACE_STATUS_META: Record<
  string,
  {
    tone: string
    icon: React.ComponentType<{ className?: string }>
  }
> = {
  todo: {
    tone: 'text-muted-foreground',
    icon: Circle
  },
  'in-progress': {
    tone: 'text-foreground',
    icon: CircleDot
  },
  'in-review': {
    tone: 'text-foreground',
    icon: GitPullRequest
  },
  completed: {
    tone: 'text-muted-foreground',
    icon: CircleCheckBig
  }
}

export function getWorkspaceStatusVisualMeta(status: WorkspaceStatus): {
  tone: string
  icon: React.ComponentType<{ className?: string }>
} {
  return DEFAULT_WORKSPACE_STATUS_META[status] ?? { tone: 'text-foreground', icon: CircleDot }
}

export function writeWorkspaceDragData(dataTransfer: DataTransfer, worktreeId: string): void {
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(WORKSPACE_STATUS_DRAG_TYPE, worktreeId)
  dataTransfer.setData('text/plain', worktreeId)
}

export function readWorkspaceDragData(dataTransfer: DataTransfer): string | null {
  const typed = dataTransfer.getData(WORKSPACE_STATUS_DRAG_TYPE)
  if (typed) {
    return typed
  }
  return dataTransfer.getData('text/plain') || null
}

export function hasWorkspaceDragData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(WORKSPACE_STATUS_DRAG_TYPE) || types.includes('text/plain')
}
