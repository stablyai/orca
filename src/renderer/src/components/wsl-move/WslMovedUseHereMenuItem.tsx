import React from 'react'
import { Undo2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { bringWslMovedProjectBack } from '@/lib/workspace/ownership/wsl-moved-project-use-here'
import { movedProjectForKey, wslMovedProjectOnHost } from '@/store/repos/wsl-moved-projects'
import { workspaceOwnerHostId } from '@/lib/workspace/ownership/workspace-row-owner-host'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'

function UseHereItem({ project }: { project: WslMovedProject | null }): React.JSX.Element | null {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  if (!project) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={() => void bringWslMovedProjectBack(project, confirm)}>
      <Undo2 className="size-3.5" />
      {t('sidebar.wslMoved.useHere', 'Use on this computer again')}
    </DropdownMenuItem>
  )
}

/** Undo for a moved project from its host row's menu, so hiding its sidebar entry never loses it. */
export function WslMovedRepoUseHereMenuItem({ repo }: { repo: Repo }): React.JSX.Element | null {
  const project = useAppStore((s) =>
    wslMovedProjectOnHost(
      s.wslMovedProjects.find((moved) => moved.kind === 'repo' && moved.id === repo.id) ?? null,
      s.runtimeEnvironments,
      getRepoExecutionHostId(repo)
    )
  )
  return <UseHereItem project={project} />
}

export function WslMovedWorkspaceUseHereMenuItem({
  workspaceId
}: {
  workspaceId: string
}): React.JSX.Element | null {
  const project = useAppStore((s) =>
    wslMovedProjectOnHost(
      movedProjectForKey(s.wslMovedProjects, workspaceId),
      s.runtimeEnvironments,
      workspaceOwnerHostId(s, workspaceId)
    )
  )
  return <UseHereItem project={project} />
}
