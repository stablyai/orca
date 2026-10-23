import type { ComponentType } from 'react'
import { FolderOpen, Globe, Monitor, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'

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

export function getAddRepoLocalStartActions({
  onBrowse,
  onOpenCloneStep,
  onOpenRemoteStep,
  onOpenCreateStep,
  browseHostKind = 'local',
  offersServerSshHosts = false
}: AddRepoLocalStartActionHandlers): {
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
    description:
      browseHostKind === 'runtime'
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

  // Why disabled: a server registers no project on its SSH hosts (each runs its own managed
  // server), so the row only says where that project can be added instead.
  const remote = offersServerSshHosts
    ? {
        kind: 'remote' as const,
        icon: Monitor,
        title: translate(
          'auto.components.sidebar.add.repo.local.start.actions.serverSshTitle',
          "Project on this server's SSH host"
        ),
        description: translate(
          'auto.components.sidebar.add.repo.local.start.actions.serverSshAddOnThisComputer',
          'Not available from a server. Add the SSH host on this computer to open its projects.'
        ),
        disabled: true,
        onClick: onOpenRemoteStep
      }
    : null
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

  const secondaryActions = remote ? [clone, remote, create] : [clone, create]

  return { primaryAction, secondaryActions }
}
