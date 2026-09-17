import React from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  classifyWorktreeScanFailure,
  getWorktreeScanFailureFixCommand
} from '../../../../../../shared/worktree-scan-failure'
import {
  canOpenScanFixTerminal,
  retryUnavailableRepoScans,
  selectHostWideScanRetryTargets,
  selectUnavailableRepoScanTargets
} from './repo-scan-unavailable'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/**
 * Marks a repo whose worktree scan failed, so its rows are retained but cannot be trusted.
 * The marker opens a panel naming the cause, offering its fix, and re-running the scan: the
 * failure is otherwise re-tried only by the next incidental refresh.
 */
export function RepoScanUnavailableIndicator({ repo }: { repo: Repo }): React.JSX.Element | null {
  const detected = useAppStore((s) => s.detectedWorktreesByRepo[repo.id])
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const repos = useAppStore((s) => s.repos)
  const allDetected = useAppStore((s) => s.detectedWorktreesByRepo)
  const [pending, setPending] = React.useState(false)
  const [retryAllPending, setRetryAllPending] = React.useState(false)
  const [fixTerminalOpen, setFixTerminalOpen] = React.useState(false)
  const executionHostId = getRepoExecutionHostId(repo)
  const scanFailureKind = classifyWorktreeScanFailure(
    detected && !detected.authoritative ? detected.unavailableReason : undefined
  )
  const retryRepoAndHostPeers = React.useCallback(async (): Promise<void> => {
    setPending(true)
    try {
      // Why: a best-effort refresh can be served by a coalesced non-authoritative scan, so the
      // failure would never clear; an explicit retry must demand a real scan.
      const scanned = await fetchWorktrees(repo.id, {
        executionHostId,
        requireAuthoritative: true
      })
      if (!scanned) {
        // Why: an authoritative refusal writes nothing, so the panel would keep quoting the
        // previous cause; a best-effort pass re-reads what the scan reports now.
        await fetchWorktrees(repo.id, { executionHostId })
        return
      }
      // Read fresh: the scan that just landed may already have settled some peers.
      const state = useAppStore.getState()
      const peers = selectHostWideScanRetryTargets({
        targets: selectUnavailableRepoScanTargets({
          repos: state.repos,
          detectedByRepo: state.detectedWorktreesByRepo
        }),
        resolvedRepoId: repo.id,
        executionHostId,
        failureKind: scanFailureKind
      })
      if (peers.length > 0) {
        await retryUnavailableRepoScans(peers, state.fetchWorktrees)
      }
    } finally {
      setPending(false)
    }
  }, [executionHostId, fetchWorktrees, repo.id, scanFailureKind])
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
  const failureKind = scanFailureKind
  const fixCommand = getWorktreeScanFailureFixCommand(failureKind)
  const showFixTerminal = fixCommand !== null && canOpenScanFixTerminal(repo)
  const unavailableTargets = selectUnavailableRepoScanTargets({
    repos,
    detectedByRepo: allDetected
  })
  const showRetryAll = unavailableTargets.length >= 2
  return (
    // Why: the panel carries recovery actions, so it is a click-revealed popover rather than a
    // hover tooltip that would close before keyboard focus reached its buttons.
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          setFixTerminalOpen(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-destructive"
          aria-label={title}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => event.stopPropagation()}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn(fixTerminalOpen ? 'w-[380px]' : 'w-72')}
      >
        <div className="space-y-2 p-3.5 text-xs">
          <div className="font-medium">{title}</div>
          {failureKind === 'unknown' ? (
            <div className="break-words text-muted-foreground">{detected.unavailableReason}</div>
          ) : (
            <div className="space-y-1">
              <div className="break-words text-muted-foreground">
                {failureKind === 'xcode-license'
                  ? translate(
                      'auto.components.sidebar.RepoScanUnavailableIndicator.xcodeLicense',
                      'Xcode license needs acceptance after a macOS upgrade. Run the fix command in a terminal, then retry.'
                    )
                  : translate(
                      'auto.components.sidebar.RepoScanUnavailableIndicator.xcodeTools',
                      'Xcode command line tools are missing. Run the fix command in a terminal, then retry.'
                    )}
              </div>
              <code className="block break-all rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px]">
                {fixCommand}
              </code>
              {!showFixTerminal ? (
                <div className="break-words text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.RepoScanUnavailableIndicator.remoteFixHint',
                    'This repo scans on another machine, so run the fix there.'
                  )}
                </div>
              ) : null}
            </div>
          )}
          <div className="text-muted-foreground">
            {translate(
              'auto.components.sidebar.RepoScanUnavailableIndicator.retained',
              'Existing worktrees are kept until a scan succeeds.'
            )}
          </div>
          {showFixTerminal && fixCommand ? (
            fixTerminalOpen ? (
              <OnboardingInlineCommandTerminal
                command={fixCommand}
                title={translate(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.fixTerminalTitle',
                  'Scan fix'
                )}
                ariaLabel={translate(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.fixTerminalAria',
                  'Scan fix terminal'
                )}
                description={translate(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.fixTerminalHint',
                  'Press Enter to run the fix, then retry the scan.'
                )}
                terminalHeightPx={160}
                terminalTopMarginPx={8}
                autoScrollIntoView={false}
                worktreeId={`repo-scan-fix-${repo.id}`}
                // Why: a clean fix exit means the cause may be gone; rescan once instead of waiting for a click.
                onCommandFinished={(exitCode) => {
                  if (exitCode === 0) {
                    void retryRepoAndHostPeers()
                  }
                }}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="w-full"
                onClick={() => setFixTerminalOpen(true)}
              >
                {translate(
                  'auto.components.sidebar.RepoScanUnavailableIndicator.openFixTerminal',
                  'Open terminal with fix'
                )}
              </Button>
            )
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="w-full"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void retryRepoAndHostPeers()}
          >
            {retryLabel}
          </Button>
          {showRetryAll ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="w-full"
              disabled={retryAllPending}
              aria-busy={retryAllPending}
              onClick={() => {
                setRetryAllPending(true)
                void retryUnavailableRepoScans(unavailableTargets, fetchWorktrees).finally(() =>
                  setRetryAllPending(false)
                )
              }}
            >
              {translate(
                'auto.components.sidebar.RepoScanUnavailableIndicator.retryAll',
                'Retry all failed scans ({{value0}})',
                { value0: String(unavailableTargets.length) }
              )}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
