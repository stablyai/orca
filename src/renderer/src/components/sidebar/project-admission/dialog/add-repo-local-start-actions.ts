import type { ComponentType } from 'react'
import { FolderOpen, Globe, Monitor, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type AddRepoLocalStartActionHandlers = {
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenRemoteStep: () => void
  onOpenCreateStep: () => void
  browseHostKind?: 'local' | 'runtime'
  /** A paired server is selected, whose own SSH hosts the dialog explains instead of offering. */
  offersServerSshHosts?: boolean
}

export type AddRepoLocalStartAction = {
  kind: 'browse' | 'clone' | 'remote' | 'create'
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
  disabled?: boolean
  onClick: () => void
}

export function getAddRepoLocalStartActions(
  {
    onBrowse,
    onOpenCloneStep,
    onOpenRemoteStep,
    onOpenCreateStep,
    browseHostKind = 'local',
    offersServerSshHosts = false
  }: AddRepoLocalStartActionHandlers,
  t: Translate = translate
): {
  primaryAction: AddRepoLocalStartAction
  secondaryActions: AddRepoLocalStartAction[]
} {
  const primaryAction = {
    kind: 'browse' as const,
    icon: FolderOpen,
    title: t('auto.components.sidebar.add.repo.local.start.actions.2281fdc8c7', 'Browse folder'),
    description:
      browseHostKind === 'runtime'
        ? t(
            'auto.components.sidebar.add.repo.local.start.actions.runtimeBrowseDescription',
            'Existing Git repository or folder on this host'
          )
        : t(
            'auto.components.sidebar.add.repo.local.start.actions.fb4fc5380e',
            'Local project, Git repo, or folder with many repos'
          ),
    onClick: onBrowse
  }

  // Server-owned SSH projects need their own managed servers; explain that route instead of enabling unsupported adds.
  const remote = offersServerSshHosts
    ? {
        kind: 'remote' as const,
        icon: Monitor,
        title: t(
          'auto.components.sidebar.add.repo.local.start.actions.serverSshTitle',
          "Project on this server's SSH host"
        ),
        description: t(
          'auto.components.sidebar.add.repo.local.start.actions.serverSshAddOnThisComputer',
          "This server can't open projects from its SSH hosts. Select that host's managed Orca server from Host, or open a folder on this server."
        ),
        disabled: true,
        onClick: onOpenRemoteStep
      }
    : null
  const clone = {
    kind: 'clone' as const,
    icon: Globe,
    title: t('auto.components.sidebar.add.repo.local.start.actions.7edb8ebe24', 'Clone from URL'),
    description: t(
      'auto.components.sidebar.add.repo.local.start.actions.5f9ffac036',
      'Clone a remote Git repository'
    ),
    onClick: onOpenCloneStep
  }
  const create = {
    kind: 'create' as const,
    icon: Plus,
    title: t(
      'auto.components.sidebar.add.repo.local.start.actions.c709860596',
      'Create new project'
    ),
    description: t(
      'auto.components.sidebar.add.repo.local.start.actions.d72789705e',
      'Start from an empty folder'
    ),
    onClick: onOpenCreateStep
  }

  const secondaryActions = remote ? [clone, remote, create] : [clone, create]

  return { primaryAction, secondaryActions }
}
