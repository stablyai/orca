import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/**
 * Marks a repo whose worktree scan failed, so its rows are retained but cannot be trusted.
 * Click re-runs the scan: the failure is otherwise re-tried only by the next incidental refresh.
 */
export function RepoScanUnavailableIndicator({ repo }: { repo: Repo }): React.JSX.Element | null {
  const detected = useAppStore((s) => s.detectedWorktreesByRepo[repo.id])
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [pending, setPending] = React.useState(false)
  if (!detected || detected.authoritative || !detected.unavailableReason) {
    return null
  }
  const title = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.title',
    'Worktree scan failed for {{value0}}',
    { value0: repo.displayName }
  )
  const retryLabel = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.retry',
    'Retry scan'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-destructive',
            pending && 'opacity-60'
          )}
          aria-label={`${title}. ${retryLabel}`}
          aria-busy={pending}
          disabled={pending}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPending(true)
            void fetchWorktrees(repo.id, {
              executionHostId: getRepoExecutionHostId(repo)
            }).finally(() => setPending(false))
          }}
        >
          <TriangleAlert className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <div className="break-words text-muted-foreground">{detected.unavailableReason}</div>
          <div className="text-muted-foreground">
            {translate(
              'auto.components.sidebar.RepoScanUnavailableIndicator.retained',
              'Existing worktrees are kept until a scan succeeds. Click to retry.'
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
