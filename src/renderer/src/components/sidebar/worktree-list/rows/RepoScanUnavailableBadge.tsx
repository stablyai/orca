import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { WorktreeScanFailureKind } from '../../../../../../shared/worktree/catalog/worktree-scan-failure'
import type { RepoScanFailure } from '../../../repo/toolchain/repo-scan-failure'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

export function RepoScanUnavailableBadge({
  repo,
  failure
}: {
  repo: Repo
  failure: RepoScanFailure
}): React.JSX.Element {
  const t = useTranslate()
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [pending, setPending] = React.useState(false)
  const title = t(
    'auto.components.sidebar.RepoScanUnavailableIndicator.title',
    'Worktree scan failed for {{value0}}',
    { value0: repo.displayName }
  )
  const retryLabel = t('auto.components.sidebar.RepoScanUnavailableIndicator.retry', 'Retry scan')
  const { executionHostId, isLocalMac, kind: failureKind, reason } = failure
  const failureMessageByKind: Partial<Record<WorktreeScanFailureKind, string>> = {
    'xcode-license': t(
      'auto.components.sidebar.RepoScanUnavailableIndicator.xcodeLicense',
      'Apple developer tools require license acceptance before Git can run.'
    ),
    'developer-tools': t(
      'auto.components.sidebar.RepoScanUnavailableIndicator.developerTools',
      'Apple command-line developer tools are missing or unavailable.'
    ),
    'architecture-mismatch': t(
      'auto.components.sidebar.RepoScanUnavailableIndicator.architectureMismatch',
      'A Git-related executable could not run because its CPU architecture is incompatible with this execution host. Install Git and related tools for the host architecture.'
    )
  }
  const failureMessage = failureMessageByKind[failureKind] ?? reason
  const diagnosticText = [
    `Repository: ${repo.displayName}`,
    ...(isLocalMac
      ? [`Path: ${repo.path}`, 'Client platform: macOS']
      : [`Execution host: ${executionHostId}`]),
    `Failure: ${reason}`
  ].join('\n')
  return (
    <TooltipProvider disableHoverableContent={false}>
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
                executionHostId
              }).finally(() => setPending(false))
            }}
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="pointer-events-auto max-w-72">
          <div className="space-y-1">
            <div className="font-medium">{title}</div>
            <div className="break-words text-muted-foreground">{failureMessage}</div>
            <div className="text-muted-foreground">
              {t(
                'auto.components.sidebar.RepoScanUnavailableIndicator.retained',
                'Existing worktrees are kept until a scan succeeds. Click the warning icon to retry.'
              )}
            </div>
            <div className="flex items-center justify-start gap-3 border-t border-border/60 pt-1">
              <button
                type="button"
                className="text-xs underline"
                onClick={() => void window.api.ui.writeClipboardText(diagnosticText)}
              >
                {t(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.copyDiagnostics',
                  'Copy diagnostics'
                )}
              </button>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
