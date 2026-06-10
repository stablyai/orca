import type { ComponentType } from 'react'
import { FolderOpen, Globe, Monitor, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type AddRepoLocalStartActionHandlers = {
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenRemoteStep: () => void
  onOpenCreateStep: () => void
}

export type AddRepoLocalStartAction = {
  kind: 'browse' | 'clone' | 'remote' | 'create'
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  onClick: () => void
}

export function getAddRepoLocalStartActions({
  isSshLikely,
  onBrowse,
  onOpenCloneStep,
  onOpenRemoteStep,
  onOpenCreateStep
}: { isSshLikely: boolean } & AddRepoLocalStartActionHandlers): {
  primaryAction: AddRepoLocalStartAction
  secondaryActions: AddRepoLocalStartAction[]
} {
  const primaryAction = {
    kind: 'browse' as const,
    icon: FolderOpen,
    title: translate(
      'auto.components.sidebar.add.repo.local.start.actions.2281fdc8c7',
      'Browse folder'
    ),
    description: translate(
      'auto.components.sidebar.add.repo.local.start.actions.fb4fc5380e',
      'Local project, Git repo, or folder with many repos'
    ),
    onClick: onBrowse
  }

  const remote = {
    kind: 'remote' as const,
    icon: Monitor,
    title: translate(
      'auto.components.sidebar.add.repo.local.start.actions.3d162cc76f',
      'Remote project'
    ),
    description: translate(
      'auto.components.sidebar.add.repo.local.start.actions.a6c20dca96',
      'Open a project from an SSH target'
    ),
    onClick: onOpenRemoteStep
  }
  const clone = {
    kind: 'clone' as const,
    icon: Globe,
    title: translate(
      'auto.components.sidebar.add.repo.local.start.actions.7edb8ebe24',
      'Clone from URL'
    ),
    description: translate(
      'auto.components.sidebar.add.repo.local.start.actions.5f9ffac036',
      'Clone a remote Git repository'
    ),
    onClick: onOpenCloneStep
  }
  const create = {
    kind: 'create' as const,
    icon: Plus,
    title: translate(
      'auto.components.sidebar.add.repo.local.start.actions.c709860596',
      'Create new project'
    ),
    description: translate(
      'auto.components.sidebar.add.repo.local.start.actions.d72789705e',
      'Start from an empty folder'
    ),
    onClick: onOpenCreateStep
  }

  // SSH-likely users reach for remote targets first, so surface that row ahead of clone.
  const secondaryActions = isSshLikely ? [remote, clone, create] : [clone, remote, create]

  return { primaryAction, secondaryActions }
}
