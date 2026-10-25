import { CircleX, FolderTree, List, Pin } from 'lucide-react'
import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { PRGroupKey } from '../../../../../../shared/workspace-view/workspace-pr-groups'
import type { SidebarHeaderIcon } from '../../../../../../shared/sidebar-list/row-types'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import {
  ConductorDoneIcon,
  ConductorProgressIcon,
  ConductorReviewIcon
} from '../../workspace-status-icons'
import { getWorkspaceStatusVisualMeta } from '../../workspace-status'

const PR_GROUP_META: Record<
  PRGroupKey,
  {
    label: string
    icon: React.ComponentType<{ className?: string }>
    tone: string
  }
> = {
  done: {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.5076efc3d2', 'Done')
    },
    icon: ConductorDoneIcon,
    tone: 'text-workspace-status-done'
  },
  'in-review': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.6798dc7c94', 'In review')
    },
    icon: ConductorReviewIcon,
    tone: 'text-workspace-status-review'
  },
  'in-progress': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.7c2f009786', 'In progress')
    },
    icon: ConductorProgressIcon,
    tone: 'text-workspace-status-progress'
  },
  closed: {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.682ed5d551', 'Closed')
    },
    icon: CircleX,
    tone: 'text-zinc-600 dark:text-zinc-300'
  }
}

const PROJECT_GROUP_META = {
  tone: 'text-foreground',
  icon: FolderTree
} as const

const PINNED_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.4aeefc5996', 'Pinned')
  },
  tone: 'text-foreground',
  icon: Pin
} as const

const ALL_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.0ed04075b8', 'All')
  },
  tone: 'text-foreground',
  icon: List
} as const

type SidebarHeaderVisual = {
  icon: React.ComponentType<{ className?: string }>
  tone: string
  /** Set for headers the builder leaves unnamed: Pinned, All and the PR lanes. */
  label?: string
}

/** What the window draws for a header's icon key; read at paint so labels follow the locale. */
export function getSidebarHeaderVisual(
  icon: SidebarHeaderIcon,
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
): SidebarHeaderVisual {
  switch (icon.kind) {
    case 'pinned':
      return PINNED_GROUP_META
    case 'all':
      return ALL_GROUP_META
    case 'project':
      return PROJECT_GROUP_META
    case 'pr-status':
      return PR_GROUP_META[icon.prGroup]
    case 'workspace-status': {
      const { icon: statusIcon, tone } = getWorkspaceStatusVisualMeta(
        workspaceStatuses.find((status) => status.id === icon.status) ?? icon.status
      )
      return { icon: statusIcon, tone }
    }
  }
}
