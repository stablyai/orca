import type React from 'react'
import {
  Ban,
  Circle,
  CircleAlert,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
  CirclePause,
  CirclePlay,
  Flag,
  GitPullRequest,
  Timer
} from 'lucide-react'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  DEFAULT_WORKSPACE_STATUS_COLOR_ID,
  DEFAULT_WORKSPACE_STATUS_ICON_ID,
  DEFAULT_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUSES,
  WORKSPACE_STATUS_COLOR_IDS,
  WORKSPACE_STATUS_ICON_IDS,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId
} from '../../../../shared/workspace-statuses'

export {
  DEFAULT_WORKSPACE_STATUS_COLOR_ID,
  DEFAULT_WORKSPACE_STATUS_ICON_ID,
  DEFAULT_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUSES,
  WORKSPACE_STATUS_COLOR_IDS,
  WORKSPACE_STATUS_ICON_IDS,
  getWorkspaceStatus,
  getWorkspaceStatusFromGroupKey,
  getWorkspaceStatusGroupKey,
  isWorkspaceStatusId
}

export const WORKSPACE_STATUS_DRAG_TYPE = 'application/x-orca-worktree-id'
export const WORKSPACE_STATUS_DRAG_IDS_TYPE = 'application/x-orca-worktree-ids'

type WorkspaceStatusColorOption = {
  id: string
  label: string
  tone: string
  swatch: string
  border: string
  laneTint: string
}

type WorkspaceStatusIconOption = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

export const WORKSPACE_STATUS_COLOR_OPTIONS: WorkspaceStatusColorOption[] = [
  {
    id: 'neutral',
    label: 'Neutral',
    tone: 'text-muted-foreground',
    swatch: 'bg-muted-foreground',
    border: 'border-t-muted-foreground/45',
    laneTint: 'bg-background/55'
  },
  {
    id: 'blue',
    label: 'Blue',
    tone: 'text-blue-600 dark:text-blue-300',
    swatch: 'bg-blue-500',
    border: 'border-t-blue-500/70',
    laneTint: 'bg-blue-500/[0.04]'
  },
  {
    id: 'sky',
    label: 'Sky',
    tone: 'text-sky-600 dark:text-sky-300',
    swatch: 'bg-sky-500',
    border: 'border-t-sky-500/70',
    laneTint: 'bg-sky-500/[0.04]'
  },
  {
    id: 'violet',
    label: 'Violet',
    tone: 'text-violet-600 dark:text-violet-300',
    swatch: 'bg-violet-500',
    border: 'border-t-violet-500/70',
    laneTint: 'bg-violet-500/[0.04]'
  },
  {
    id: 'amber',
    label: 'Amber',
    tone: 'text-amber-700 dark:text-amber-200',
    swatch: 'bg-amber-500',
    border: 'border-t-amber-500/70',
    laneTint: 'bg-amber-500/[0.04]'
  },
  {
    id: 'emerald',
    label: 'Emerald',
    tone: 'text-emerald-700 dark:text-emerald-200',
    swatch: 'bg-emerald-500',
    border: 'border-t-emerald-500/70',
    laneTint: 'bg-emerald-500/[0.04]'
  },
  {
    id: 'rose',
    label: 'Rose',
    tone: 'text-rose-600 dark:text-rose-300',
    swatch: 'bg-rose-500',
    border: 'border-t-rose-500/70',
    laneTint: 'bg-rose-500/[0.04]'
  },
  {
    id: 'zinc',
    label: 'Zinc',
    tone: 'text-zinc-600 dark:text-zinc-300',
    swatch: 'bg-zinc-500',
    border: 'border-t-zinc-500/70',
    laneTint: 'bg-zinc-500/[0.04]'
  }
]

export const WORKSPACE_STATUS_ICON_OPTIONS: WorkspaceStatusIconOption[] = [
  { id: 'circle', label: 'Circle', icon: Circle },
  { id: 'circle-dot', label: 'Dot', icon: CircleDot },
  { id: 'circle-dashed', label: 'Dashed', icon: CircleDashed },
  { id: 'circle-ellipsis', label: 'Waiting', icon: CircleEllipsis },
  { id: 'git-pull-request', label: 'Review', icon: GitPullRequest },
  { id: 'timer', label: 'Timer', icon: Timer },
  { id: 'flag', label: 'Flag', icon: Flag },
  { id: 'circle-alert', label: 'Alert', icon: CircleAlert },
  { id: 'circle-pause', label: 'Paused', icon: CirclePause },
  { id: 'circle-play', label: 'Play', icon: CirclePlay },
  { id: 'circle-check', label: 'Done', icon: CircleCheckBig },
  { id: 'ban', label: 'Blocked', icon: Ban }
]

const FALLBACK_COLOR_OPTION: WorkspaceStatusColorOption = WORKSPACE_STATUS_COLOR_OPTIONS[0] ?? {
  id: DEFAULT_WORKSPACE_STATUS_COLOR_ID,
  label: 'Neutral',
  tone: 'text-muted-foreground',
  swatch: 'bg-muted-foreground',
  border: 'border-t-muted-foreground/45',
  laneTint: 'bg-background/55'
}

const FALLBACK_ICON_OPTION: WorkspaceStatusIconOption = WORKSPACE_STATUS_ICON_OPTIONS[1] ?? {
  id: DEFAULT_WORKSPACE_STATUS_ICON_ID,
  label: 'Dot',
  icon: CircleDot
}

const DEFAULT_STATUS_VISUALS: Record<
  string,
  {
    color: string
    icon: string
  }
> = {
  todo: {
    color: 'neutral',
    icon: 'circle'
  },
  'in-progress': {
    color: 'blue',
    icon: 'circle-dot'
  },
  'in-review': {
    color: 'violet',
    icon: 'git-pull-request'
  },
  completed: {
    color: 'emerald',
    icon: 'circle-check'
  }
}

export function getWorkspaceStatusVisualMeta(status: WorkspaceStatus | WorkspaceStatusDefinition): {
  tone: string
  swatch: string
  border: string
  laneTint: string
  icon: React.ComponentType<{ className?: string }>
} {
  const statusId = typeof status === 'string' ? status : status.id
  const visual = typeof status === 'string' ? DEFAULT_STATUS_VISUALS[status] : status
  const colorId = visual?.color ?? DEFAULT_STATUS_VISUALS[statusId]?.color
  const iconId = visual?.icon ?? DEFAULT_STATUS_VISUALS[statusId]?.icon
  const color =
    WORKSPACE_STATUS_COLOR_OPTIONS.find((option) => option.id === colorId) ??
    WORKSPACE_STATUS_COLOR_OPTIONS.find(
      (option) => option.id === DEFAULT_WORKSPACE_STATUS_COLOR_ID
    ) ??
    FALLBACK_COLOR_OPTION
  const icon =
    WORKSPACE_STATUS_ICON_OPTIONS.find((option) => option.id === iconId) ??
    WORKSPACE_STATUS_ICON_OPTIONS.find(
      (option) => option.id === DEFAULT_WORKSPACE_STATUS_ICON_ID
    ) ??
    FALLBACK_ICON_OPTION

  return {
    tone: color.tone,
    swatch: color.swatch,
    border: color.border,
    laneTint: color.laneTint,
    icon: icon.icon
  }
}

export function writeWorkspaceDragData(
  dataTransfer: DataTransfer,
  worktreeIdOrIds: string | readonly string[]
): void {
  const worktreeIds = Array.isArray(worktreeIdOrIds) ? worktreeIdOrIds : [worktreeIdOrIds]
  const [firstWorktreeId] = worktreeIds
  if (!firstWorktreeId) {
    return
  }
  dataTransfer.effectAllowed = 'move'
  // Why: keep the original single-id payload for older drop targets while
  // board-to-board drags can move the whole selected batch.
  dataTransfer.setData(WORKSPACE_STATUS_DRAG_TYPE, firstWorktreeId)
  dataTransfer.setData(WORKSPACE_STATUS_DRAG_IDS_TYPE, JSON.stringify(worktreeIds))
  dataTransfer.setData('text/plain', firstWorktreeId)
}

export function readWorkspaceDragData(dataTransfer: DataTransfer): string | null {
  const typed = dataTransfer.getData(WORKSPACE_STATUS_DRAG_TYPE)
  if (typed) {
    return typed
  }
  return dataTransfer.getData('text/plain') || null
}

export function readWorkspaceDragDataIds(dataTransfer: DataTransfer): string[] {
  const rawIds = dataTransfer.getData(WORKSPACE_STATUS_DRAG_IDS_TYPE)
  if (rawIds) {
    try {
      const parsed: unknown = JSON.parse(rawIds)
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      }
    } catch {
      // Fall back to the legacy single-card payload below.
    }
  }
  const singleId = readWorkspaceDragData(dataTransfer)
  return singleId ? [singleId] : []
}

export function hasWorkspaceDragData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return (
    types.includes(WORKSPACE_STATUS_DRAG_IDS_TYPE) ||
    types.includes(WORKSPACE_STATUS_DRAG_TYPE) ||
    types.includes('text/plain')
  )
}
