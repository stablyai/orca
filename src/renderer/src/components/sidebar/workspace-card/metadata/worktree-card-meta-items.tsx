import React from 'react'
import { AlertTriangle, GitMerge } from 'lucide-react'

import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { Repo } from '../../../../../../shared/repo-types'
import '../activity/worktree-card-empty-inputs'
import { conflictOperationLabel } from './worktree-conflict-label'
import { getDirectoryName } from '../controller/worktree-card-model'

export function WorktreeCardMetaRepoBadge({
  repo,
  showName
}: {
  repo: Repo
  showName: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label={repo.displayName}
          className={cn(
            'flex items-center gap-1.5 px-1.5 py-0.5 rounded-[4px] bg-accent border border-border dark:bg-accent/50 dark:border-border/60',
            // Why: keep a 6rem name floor (+1.625rem chrome) so the branch shrinks first; grow only into width the branch leaves free.
            showName
              ? 'min-w-0 max-w-max shrink-0 grow basis-[7.625rem]'
              : 'shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
          // Why: without the name, the tooltip is the only way to read it, so keyboard users must reach it.
          {...(showName ? {} : { role: 'img', tabIndex: 0 })}
        >
          <RepoBadgeMark color={repo.badgeColor} />
          {showName && (
            <span className="min-w-0 truncate text-[10px] font-semibold text-foreground leading-none lowercase">
              {repo.displayName}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {repo.displayName}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardFolderPath({ path }: { path: string }): React.JSX.Element {
  return (
    <span
      className="min-w-0 truncate font-mono text-[11px] leading-none text-muted-foreground"
      title={path}
    >
      {getDirectoryName(path)}
    </span>
  )
}

export function WorktreeCardConflictBadge({
  operation
}: {
  operation: Parameters<typeof conflictOperationLabel>[0]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Badge
      variant="outline"
      className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 gap-1 text-amber-600 border-amber-500/30 bg-amber-500/5 dark:text-amber-400 dark:border-amber-400/30 dark:bg-amber-400/5 leading-none"
    >
      <GitMerge className="size-2.5" />
      {conflictOperationLabel(operation, t)}
    </Badge>
  )
}

export function WorktreeCardRemoteBranchConflict({
  remote,
  branchName
}: {
  remote: string
  branchName: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-0.5 flex items-start gap-1.5 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-[1px] size-3 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(
          'auto.components.sidebar.WorktreeCard.a88c92d0e3',
          '{{value0}}/{{value1}} already exists.',
          { value0: remote, value1: branchName }
        )}
      </span>
    </div>
  )
}

export function WorktreeCardDeleteFailed({ error }: { error: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug text-destructive"
          data-worktree-card-delete-failed=""
        >
          <AlertTriangle className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            {t('auto.components.sidebar.WorktreeCard.deleteFailed', 'Delete failed')}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-72 break-words">
        {error}
      </TooltipContent>
    </Tooltip>
  )
}
