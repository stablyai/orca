import type { ComponentType } from 'react'
import { FolderOpen, Globe, Monitor, Plus } from 'lucide-react'

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
  secondaryAction: AddRepoLocalStartAction | null
  moreOptions: AddRepoLocalStartAction[]
} {
  const primaryAction = isSshLikely
    ? {
        kind: 'remote' as const,
        icon: Monitor,
        title: 'Remote project',
        description: 'Open a project from an SSH target',
        onClick: onOpenRemoteStep
      }
    : {
        kind: 'browse' as const,
        icon: FolderOpen,
        title: 'Browse folder',
        description: 'Local project, Git repo, or folder with many repos',
        onClick: onBrowse
      }

  const secondaryAction = isSshLikely
    ? {
        kind: 'browse' as const,
        icon: FolderOpen,
        title: 'Browse folder',
        description: 'Local project or folder',
        onClick: onBrowse
      }
    : null

  const moreOptions = [
    {
      kind: 'clone' as const,
      icon: Globe,
      title: 'Clone from URL',
      description: 'Clone a remote Git repository',
      onClick: onOpenCloneStep
    },
    ...(isSshLikely
      ? []
      : [
          {
            kind: 'remote' as const,
            icon: Monitor,
            title: 'Remote project',
            description: 'Open a project from an SSH target',
            onClick: onOpenRemoteStep
          }
        ]),
    {
      kind: 'create' as const,
      icon: Plus,
      title: 'Create new project',
      description: 'Start from an empty folder',
      onClick: onOpenCreateStep
    }
  ]

  return { primaryAction, secondaryAction, moreOptions }
}
