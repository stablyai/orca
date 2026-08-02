import type { ComponentType } from 'react'
import { FolderOpen, Globe, Monitor, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type AddRepoLocalStartActionHandlers = {
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenRemoteStep: () => void
  onOpenCreateStep: () => void
  showRemoteAction?: boolean
  canCreateProject?: boolean
  browseHostKind?: 'local' | 'ssh' | 'runtime'
}

export type AddRepoLocalStartAction = {
  kind: 'browse' | 'clone' | 'remote' | 'create'
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  disabled?: boolean
  onClick: () => void
}

export function getAddRepoLocalStartActions({
  isSshLikely,
  onBrowse,
  onOpenCloneStep,
  onOpenRemoteStep,
  onOpenCreateStep,
  showRemoteAction = true,
  canCreateProject = true,
  browseHostKind = 'local'
}: { isSshLikely: boolean } & AddRepoLocalStartActionHandlers): {
  primaryAction: AddRepoLocalStartAction
  secondaryActions: AddRepoLocalStartAction[]
} {
  const primaryAction = {
    kind: 'browse' as const,
    icon: FolderOpen,
    title:
      browseHostKind === 'ssh'
        ? translate(
            'auto.components.sidebar.add.repo.local.start.actions.sshBrowseTitle',
            'Open project on SSH host'
          )
        : translate(
            'auto.components.sidebar.add.repo.local.start.actions.2281fdc8c7',
            'Browse folder'
          ),
    description:
      browseHostKind === 'ssh'
        ? translate(
            'auto.components.sidebar.add.repo.local.start.actions.sshBrowseDescription',
            'Existing Git repository or folder on this SSH host'
          )
        : browseHostKind === 'runtime'
          ? translate(
              'auto.components.sidebar.add.repo.local.start.actions.runtimeBrowseDescription',
              'Existing Git repository or folder on this host'
            )
          : translate(
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
      'Project on SSH host'
    ),
    description: translate(
      'auto.components.sidebar.add.repo.local.start.actions.a6c20dca96',
      'Open a project folder from an SSH host'
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
    description: canCreateProject
      ? translate(
          'auto.components.sidebar.add.repo.local.start.actions.d72789705e',
          'Start from an empty folder'
        )
      : translate(
          'auto.components.sidebar.add.repo.local.start.actions.sshCreateUnavailable',
          'Not available for SSH hosts yet'
        ),
    disabled: !canCreateProject,
    onClick: onOpenCreateStep
  }

  const secondaryActions = showRemoteAction
    ? isSshLikely
      ? [remote, clone, create]
      : [clone, remote, create]
    : [clone, create]

  return { primaryAction, secondaryActions }
}
