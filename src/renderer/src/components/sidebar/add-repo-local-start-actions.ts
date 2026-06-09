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
  secondaryActions: AddRepoLocalStartAction[]
} {
  const primaryAction = {
    kind: 'browse' as const,
    icon: FolderOpen,
    title: 'Browse folder',
    description: 'Local project, Git repo, or folder with many repos',
    onClick: onBrowse
  }

  const remote = {
    kind: 'remote' as const,
    icon: Monitor,
    title: 'Remote project',
    description: 'Open a project from an SSH target',
    onClick: onOpenRemoteStep
  }
  const clone = {
    kind: 'clone' as const,
    icon: Globe,
    title: 'Clone from URL',
    description: 'Clone a remote Git repository',
    onClick: onOpenCloneStep
  }
  const create = {
    kind: 'create' as const,
    icon: Plus,
    title: 'Create new project',
    description: 'Start from an empty folder',
    onClick: onOpenCreateStep
  }

  // SSH-likely users reach for remote targets first, so surface that row ahead of clone.
  const secondaryActions = isSshLikely ? [remote, clone, create] : [clone, remote, create]

  return { primaryAction, secondaryActions }
}
