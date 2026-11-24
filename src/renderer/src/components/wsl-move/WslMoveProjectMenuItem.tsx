import React from 'react'
import { FolderInput } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { resolveFolderWorkspaceHost } from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WslMoveRowRef } from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  openWslMoveDialogFor,
  useWslMoveTargetForPath,
  useWslMoveTargetForRepo
} from './wsl-move-entry'

function MoveItem({
  target,
  project
}: {
  target: ReturnType<typeof useWslMoveTargetForRepo>
  project: WslMoveRowRef
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!target) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={() => openWslMoveDialogFor(target.distro, project)}>
      <FolderInput className="size-3.5" />
      {t('wslMove.entry.projectMenu', 'Move to {{distro}} host…', { distro: target.distro })}
    </DropdownMenuItem>
  )
}

/** "Move to <distro> host…" for a local WSL project; nothing where no move is offered. */
export function WslMoveProjectMenuItem({ repo }: { repo: Repo }): React.JSX.Element | null {
  const target = useWslMoveTargetForRepo(repo)
  return <MoveItem target={target} project={{ kind: 'repo', id: repo.id }} />
}

/** The same for a local folder workspace, from its row's menu. */
export function WslMoveFolderWorkspaceMenuItem({
  folderWorkspaceId
}: {
  folderWorkspaceId: string
}): React.JSX.Element | null {
  const folder = useAppStore((s) => {
    const entry = selectFolderWorkspaces(s).find((row) => row.id === folderWorkspaceId)
    // Main's rule: this row alone, as another host may hold a folder workspace with the same id.
    return entry &&
      resolveFolderWorkspaceHost(
        { repos: s.repos, projectGroups: s.projectGroups, folderWorkspaces: [entry] },
        entry.id
      ).kind === 'local'
      ? entry
      : undefined
  })
  const target = useWslMoveTargetForPath(folder?.folderPath, !!folder)
  return folder ? <MoveItem target={target} project={{ kind: 'folder', id: folder.id }} /> : null
}
