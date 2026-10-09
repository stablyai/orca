import React from 'react'
import { FolderSymlink, FolderX } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getRepoPathStatusDescription,
  getRepoPathStatusTitle,
  isActionableRepoPathStatus
} from '@/lib/repo-path-status-copy'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../../../shared/repo-host-identity'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/** Marks a repo whose folder moved or vanished; click opens the relink dialog. */
export function RepoPathStatusIndicator({ repo }: { repo: Repo }): React.JSX.Element | null {
  const hostId = getRepoExecutionHostId(repo)
  const entry = useAppStore((s) => s.repoPathStatuses[getRepoHostIdentityForParts(repo.id, hostId)])
  const openModal = useAppStore((s) => s.openModal)
  // An entry checked against an older path says nothing about the current one.
  const status = entry?.path === repo.path ? entry.status : null
  if (!isActionableRepoPathStatus(status)) {
    return null
  }
  const title = getRepoPathStatusTitle(status)
  const actionLabel =
    status.state === 'moved'
      ? translate('auto.components.sidebar.RepoPathStatusIndicator.update', 'Update location…')
      : translate('auto.components.sidebar.RepoPathStatusIndicator.locate', 'Locate…')
  const Icon = status.state === 'moved' ? FolderSymlink : FolderX
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          data-repo-path-status={status.state}
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]',
            status.state === 'missing' ? 'text-destructive' : 'text-muted-foreground'
          )}
          aria-label={`${title}. ${actionLabel}`}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            openModal('relink-repo', { repoId: repo.id, hostId })
          }}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <div className="break-words text-muted-foreground">
            {getRepoPathStatusDescription(status, repo.path)}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
