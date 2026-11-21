import React from 'react'
import { Undo2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { bringWslMovedProjectBack } from '@/lib/workspace/ownership/wsl-moved-project-use-here'
import {
  movedProjectForKey,
  wslMovedProjectOnHost,
  wslMovedRowOwnerHostId
} from '@/store/repos/wsl-moved-projects'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
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

/** The clicked row's own host: the same project id can be listed under several hosts. */
export function WslMovedWorkspaceUseHereMenuItem({
  worktree
}: {
  worktree: Pick<Worktree, 'id' | 'hostId'>
}): React.JSX.Element | null {
  const project = useAppStore((s) => {
    const hostId = wslMovedRowOwnerHostId(
      { folderWorkspaces: selectFolderWorkspaces(s), projectGroups: s.projectGroups },
      worktree
    )
    return hostId
      ? wslMovedProjectOnHost(
          movedProjectForKey(s.wslMovedProjects, worktree.id),
          s.runtimeEnvironments,
          hostId
        )
      : null
  })
  return <UseHereItem project={project} />
}
