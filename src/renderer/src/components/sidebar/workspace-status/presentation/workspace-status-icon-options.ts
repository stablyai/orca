import React from 'react'
import {
  Ban,
  Circle,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
  CirclePause,
  CirclePlay,
  Flag,
  Timer
} from 'lucide-react'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import {
  ConductorDoneIcon,
  ConductorProgressIcon,
  ConductorReviewIcon
} from './workspace-status-icons'

export type WorkspaceStatusIconOption = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

export const getWorkspaceStatusIconOptions = createLocalizedCatalog(
  (): WorkspaceStatusIconOption[] => [
    {
      id: 'circle',
      label: translate('auto.components.sidebar.workspace.status.b4a7101fe1', 'Circle'),
      icon: Circle
    },
    {
      id: 'circle-dot',
      label: translate('auto.components.sidebar.workspace.status.a702bc08d4', 'Dot'),
      icon: CircleDot
    },
    {
      id: 'circle-progress',
      label: translate('auto.components.sidebar.workspace.status.226d1e7773', 'Progress'),
      icon: ConductorProgressIcon
    },
    {
      id: 'circle-dashed',
      label: translate('auto.components.sidebar.workspace.status.821d156f54', 'Dashed'),
      icon: CircleDashed
    },
    {
      id: 'circle-ellipsis',
      label: translate('auto.components.sidebar.workspace.status.5f9ca31a84', 'Waiting'),
      icon: CircleEllipsis
    },
    {
      id: 'git-pull-request',
      label: translate('auto.components.sidebar.workspace.status.409528031f', 'Review'),
      icon: ConductorReviewIcon
    },
    {
      id: 'timer',
      label: translate('auto.components.sidebar.workspace.status.251c817bdd', 'Timer'),
      icon: Timer
    },
    {
      id: 'flag',
      label: translate('auto.components.sidebar.workspace.status.6380517b10', 'Flag'),
      icon: Flag
    },
    {
      id: 'circle-alert',
      label: translate('auto.components.sidebar.workspace.status.642da473f2', 'Alert'),
      icon: CircleAlert
    },
    {
      id: 'circle-pause',
      label: translate('auto.components.sidebar.workspace.status.111db162bf', 'Paused'),
      icon: CirclePause
    },
    {
      id: 'circle-play',
      label: translate('auto.components.sidebar.workspace.status.2c19d1db33', 'Play'),
      icon: CirclePlay
    },
    {
      id: 'circle-check',
      label: translate('auto.components.sidebar.workspace.status.6b8285b8dd', 'Done'),
      icon: ConductorDoneIcon
    },
    {
      id: 'ban',
      label: translate('auto.components.sidebar.workspace.status.93ac840dcb', 'Blocked'),
      icon: Ban
    },
    {
      id: 'conductor-done',
      label: translate('auto.components.sidebar.workspace.status.6b8285b8dd', 'Done'),
      icon: ConductorDoneIcon
    },
    {
      id: 'conductor-review',
      label: translate('auto.components.sidebar.workspace.status.6c1efa2cf8', 'In review'),
      icon: ConductorReviewIcon
    },
    {
      id: 'conductor-progress',
      label: translate('auto.components.sidebar.workspace.status.cb387159f6', 'In progress'),
      icon: ConductorProgressIcon
    }
  ]
)
