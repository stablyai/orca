import React from 'react'
import { PowerOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

type WslDistroNotRunning = NonNullable<DetectedWorktreeListResult['wslDistroStopped']>

/** A stopped distro is a state, not a failure: neutral, with stored rows and a click that may start it. */
export function RepoWslDistroStoppedIndicator({
  repo,
  notRunning
}: {
  repo: Repo
  notRunning: WslDistroNotRunning
}): React.JSX.Element {
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [pending, setPending] = React.useState(false)
  const title =
    notRunning.state === 'stopped'
      ? translate(
          'auto.components.sidebar.RepoScanUnavailableIndicator.wslStoppedTitle',
          'WSL distro {{value0}} is stopped',
          { value0: notRunning.distro }
        )
      : translate(
          'auto.components.sidebar.RepoScanUnavailableIndicator.wslUnverifiableTitle',
          "Couldn't confirm WSL distro {{value0}} is running",
          { value0: notRunning.distro }
        )
  // The click is a user act, so this scan may start the distro; a failed start still re-lists.
  const startAndScan = async (): Promise<void> => {
    try {
      await window.api.worktrees.scanStartingWslDistro?.({ repoId: repo.id })
    } catch {
      // The re-list below reports the distro's state.
    }
    await fetchWorktrees(repo.id, { executionHostId: getRepoExecutionHostId(repo) })
  }
  const startAndScanLabel = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.wslStartAndScan',
    'Start distro and scan'
  )
  return (
    <TooltipProvider disableHoverableContent={false}>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-repo-header-action=""
            className={cn(
              'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground',
              pending && 'opacity-60'
            )}
            aria-label={`${title}. ${startAndScanLabel}`}
            aria-busy={pending}
            disabled={pending}
            onKeyDown={stopRepoHeaderKeyboardToggle}
            onPointerDown={handleRepoHeaderActionPointerDown}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setPending(true)
              void startAndScan().finally(() => setPending(false))
            }}
          >
            <PowerOff className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
          <div className="space-y-1">
            <div className="font-medium">{title}</div>
            <div className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.wslRetained',
                'Showing the worktrees Orca already knew about. They refresh when Orca sees the distro running.'
              )}
            </div>
            <div className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.wslStartAndScanHint',
                'Click the icon to start the distro and scan again.'
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
