import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  classifyWorktreeScanFailure,
  type WorktreeScanFailureKind
} from '../../../../../../shared/worktree-scan-failure'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

const WORKTREE_SCAN_FIX_COMMANDS = {
  'xcode-license': 'sudo xcodebuild -license',
  'developer-tools': 'xcode-select --install'
} as const satisfies Partial<Record<WorktreeScanFailureKind, string>>

function fixCommandForFailureKind(kind: WorktreeScanFailureKind): string | undefined {
  return WORKTREE_SCAN_FIX_COMMANDS[kind]
}

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
  const executionHostId = getRepoExecutionHostId(repo)
  const isLocalHost = executionHostId === 'local' && !repo.connectionId
  const isLocalMac = isLocalHost && navigator.userAgent.includes('Mac')
  const failureKind: WorktreeScanFailureKind =
    detected.failureKind ??
    (isLocalMac ? classifyWorktreeScanFailure(detected.unavailableReason) : 'unknown')
  const failureMessageByKind: Partial<Record<WorktreeScanFailureKind, string>> = {
    'xcode-license': translate(
      'auto.components.sidebar.RepoScanUnavailableIndicator.xcodeLicense',
      'Apple developer tools require license acceptance before Git can run.'
    ),
    'developer-tools': translate(
      'auto.components.sidebar.RepoScanUnavailableIndicator.developerTools',
      'Apple command-line developer tools are missing or unavailable.'
    ),
    'architecture-mismatch': translate(
      'auto.components.sidebar.RepoScanUnavailableIndicator.architectureMismatch',
      'A Git-related executable could not run because its CPU architecture is incompatible with this execution host. Install Git and related tools for the host architecture.'
    )
  }
  const failureMessage = failureMessageByKind[failureKind] ?? detected.unavailableReason
  const fixCommand = isLocalMac ? fixCommandForFailureKind(failureKind) : undefined
  const diagnosticText = [
    `Repository: ${repo.displayName}`,
    ...(isLocalMac
      ? [`Path: ${repo.path}`, 'Client platform: macOS']
      : [`Execution host: ${executionHostId}`]),
    `Failure: ${detected.unavailableReason}`
  ].join('\n')
  const copyText = async (value: string): Promise<void> => {
    await window.api.ui.writeClipboardText(value)
  }
  return (
    <TooltipProvider disableHoverableContent={false}>
      <Tooltip delayDuration={400}>
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
            {fixCommand ? (
              <div>
                <div className="break-words font-mono text-xs text-muted-foreground">
                  {fixCommand}
                </div>
              </div>
            ) : null}
            <div className="text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.retained',
                'Existing worktrees are kept until a scan succeeds. Click to retry.'
              )}
            </div>
            <div className="flex items-center justify-start gap-3 border-t border-border/60 pt-1">
              {fixCommand ? (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => void copyText(fixCommand)}
                >
                  {translate(
                    'auto.components.sidebar.RepoScanUnavailableIndicator.copyCommand',
                    'Copy command'
                  )}
                </button>
              ) : null}
              <button
                type="button"
                className="text-xs underline"
                onClick={() => void copyText(diagnosticText)}
              >
                {translate(
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
