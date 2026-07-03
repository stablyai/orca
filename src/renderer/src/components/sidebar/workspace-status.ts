import React from 'react'
import { CircleDot } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import {
  getWorkspaceStatusIconOptions,
  type WorkspaceStatusIconOption
} from './workspace-status-icon-options'

export { getWorkspaceStatusIconOptions }

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

export {
  hasWorkspaceDragData,
  readWorkspaceDragData,
  readWorkspaceDragDataIds,
  WORKSPACE_STATUS_DRAG_ID_MAX_COUNT,
  WORKSPACE_STATUS_DRAG_IDS_TYPE,
  WORKSPACE_STATUS_DRAG_PAYLOAD_MAX_BYTES,
  WORKSPACE_STATUS_DRAG_TYPE,
  writeWorkspaceDragData
} from './workspace-status-drag-data'

type WorkspaceStatusColorOption = {
  id: string
  label: string
  tone: string
  swatch: string
  border: string
  laneTint: string
}

export const getWorkspaceStatusColorOptions = createLocalizedCatalog(() => [
  {
    id: 'neutral',
    label: translate('auto.components.sidebar.workspace.status.52e3c6e2a4', 'Neutral'),
    tone: 'text-muted-foreground',
    swatch: 'bg-muted-foreground',
    border: 'border-t-muted-foreground/45',
    laneTint: 'bg-background/55'
  },
  {
    id: 'blue',
    label: translate('auto.components.sidebar.workspace.status.fc3b92756c', 'Blue'),
    tone: 'text-blue-600 dark:text-blue-300',
    swatch: 'bg-blue-500',
    border: 'border-t-blue-500/70',
    laneTint: 'bg-blue-500/[0.04]'
  },
  {
    id: 'sky',
    label: translate('auto.components.sidebar.workspace.status.6437a8c253', 'Sky'),
    tone: 'text-sky-600 dark:text-sky-300',
    swatch: 'bg-sky-500',
    border: 'border-t-sky-500/70',
    laneTint: 'bg-sky-500/[0.04]'
  },
  {
    id: 'violet',
    label: translate('auto.components.sidebar.workspace.status.1b81da243a', 'Violet'),
    tone: 'text-violet-600 dark:text-violet-300',
    swatch: 'bg-violet-500',
    border: 'border-t-violet-500/70',
    laneTint: 'bg-violet-500/[0.04]'
  },
  {
    id: 'amber',
    label: translate('auto.components.sidebar.workspace.status.7cebab6d4a', 'Amber'),
    tone: 'text-amber-700 dark:text-amber-200',
    swatch: 'bg-amber-500',
    border: 'border-t-amber-500/70',
    laneTint: 'bg-amber-500/[0.04]'
  },
  {
    id: 'emerald',
    label: translate('auto.components.sidebar.workspace.status.ddf25b6262', 'Emerald'),
    tone: 'text-emerald-700 dark:text-emerald-200',
    swatch: 'bg-emerald-500',
    border: 'border-t-emerald-500/70',
    laneTint: 'bg-emerald-500/[0.04]'
  },
  {
    id: 'rose',
    label: translate('auto.components.sidebar.workspace.status.7adb43ecf0', 'Rose'),
    tone: 'text-rose-600 dark:text-rose-300',
    swatch: 'bg-rose-500',
    border: 'border-t-rose-500/70',
    laneTint: 'bg-rose-500/[0.04]'
  },
  {
    id: 'zinc',
    label: translate('auto.components.sidebar.workspace.status.caabd5ca85', 'Zinc'),
    tone: 'text-zinc-600 dark:text-zinc-300',
    swatch: 'bg-zinc-500',
    border: 'border-t-zinc-500/70',
    laneTint: 'bg-zinc-500/[0.04]'
  },
  {
    id: 'conductor-done',
    label: translate('auto.components.sidebar.workspace.status.895f381714', 'Conductor Done'),
    tone: 'text-[#c7a594]',
    swatch: 'bg-[#c7a594]',
    border: 'border-t-[#c7a594]/70',
    laneTint: 'bg-[#c7a594]/[0.04]'
  },
  {
    id: 'conductor-review',
    label: translate('auto.components.sidebar.workspace.status.caebe3c10f', 'Conductor Review'),
    tone: 'text-[#16a34a]',
    swatch: 'bg-[#16a34a]',
    border: 'border-t-[#16a34a]/70',
    laneTint: 'bg-[#16a34a]/[0.04]'
  },
  {
    id: 'conductor-progress',
    label: translate('auto.components.sidebar.workspace.status.1a9383112b', 'Conductor Progress'),
    tone: 'text-[#d4a300]',
    swatch: 'bg-[#d4a300]',
    border: 'border-t-[#d4a300]/70',
    laneTint: 'bg-[#d4a300]/[0.04]'
  }
])

function getFallbackColorOption(): WorkspaceStatusColorOption {
  return (
    getWorkspaceStatusColorOptions()[0] ?? {
      id: DEFAULT_WORKSPACE_STATUS_COLOR_ID,
      label: translate('auto.components.sidebar.workspace.status.52e3c6e2a4', 'Neutral'),
      tone: 'text-muted-foreground',
      swatch: 'bg-muted-foreground',
      border: 'border-t-muted-foreground/45',
      laneTint: 'bg-background/55'
    }
  )
}

function getFallbackIconOption(): WorkspaceStatusIconOption {
  return (
    getWorkspaceStatusIconOptions()[1] ?? {
      id: DEFAULT_WORKSPACE_STATUS_ICON_ID,
      label: translate('auto.components.sidebar.workspace.status.a702bc08d4', 'Dot'),
      icon: CircleDot
    }
  )
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
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  'in-review': {
    color: 'conductor-review',
    icon: 'conductor-review'
  },
  completed: {
    color: 'conductor-done',
    icon: 'conductor-done'
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
    getWorkspaceStatusColorOptions().find((option) => option.id === colorId) ??
    getWorkspaceStatusColorOptions().find(
      (option) => option.id === DEFAULT_WORKSPACE_STATUS_COLOR_ID
    ) ??
    getFallbackColorOption()
  const iconOptions = getWorkspaceStatusIconOptions()
  const icon =
    iconOptions.find((option) => option.id === iconId) ??
    iconOptions.find((option) => option.id === DEFAULT_WORKSPACE_STATUS_ICON_ID) ??
    getFallbackIconOption()

  return {
    tone: color.tone,
    swatch: color.swatch,
    border: color.border,
    laneTint: color.laneTint,
    icon: icon.icon
  }
}
