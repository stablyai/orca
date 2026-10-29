import React from 'react'
import { FolderInput } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { Repo } from '../../../../shared/repo-types'
import { openWslMoveDialogFor, useWslMoveTargetForRepo } from './wsl-move-entry'

/** "Move to <distro> host…" for a local WSL project; nothing where no move is offered. */
export function WslMoveProjectMenuItem({ repo }: { repo: Repo }): React.JSX.Element | null {
  const distro = useWslMoveTargetForRepo(repo)
  if (!distro) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={() => openWslMoveDialogFor(distro, { kind: 'repo', id: repo.id })}>
      <FolderInput className="size-3.5" />
      {translate('wslMove.entry.projectMenu', 'Move to {{distro}} host…', { distro })}
    </DropdownMenuItem>
  )
}
