import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { cn } from '@/lib/class-names'
import { recomputeOn } from '@/lib/recompute-on'
import { AgentCommandFailedDialog } from '@/components/agent-command-failure/AgentCommandFailedDialog'
import { useBranchAutoRenameRetry } from './use-branch-auto-rename-retry'
import { branchAutoRenameReasonText } from './branch-auto-rename-reason-copy'

type AutoRenameFailedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  executionHostId?: ExecutionHostId
  worktreeName: string
  /** Persisted failure message — headline plus a sanitized output excerpt. */
  error: string
}

/** Two stacked labels in one grid cell keep the button width stable while the label swaps. */
function SwapLabel({ busy, idle, busyLabel }: { busy: boolean; idle: string; busyLabel: string }) {
  return (
    <span className="grid" aria-hidden="true">
      <span
        className={cn(
          'col-start-1 row-start-1 transition-opacity duration-0',
          busy ? 'opacity-0 delay-200' : 'opacity-100'
        )}
      >
        {idle}
      </span>
      <span
        className={cn(
          'col-start-1 row-start-1 transition-opacity duration-0',
          busy ? 'opacity-100 delay-200' : 'opacity-0'
        )}
      >
        {busyLabel}
      </span>
    </span>
  )
}

export function AutoRenameFailedDialog({
  open,
  worktreeId,
  worktreeName,
  executionHostId,
  onOpenChange,
  error
}: AutoRenameFailedDialogProps): React.JSX.Element {
  const t = useTranslate()
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const [dismissing, setDismissing] = useState(false)
  const tryAgainRef = useRef<HTMLButtonElement>(null)
  // Each open starts a session; queued focus from an earlier session or a closed dialog is void.
  const openSession = useRef({ count: 0, open })
  useLayoutEffect(() => {
    openSession.current = { count: openSession.current.count + 1, open }
  }, [open])
  const dismissRef = useRef<HTMLButtonElement>(null)
  // A final retry result can clear the persisted error while the dialog stays open on its reason.
  const [shownError, setShownError] = useState(error)
  if (error && error !== shownError) {
    setShownError(error)
  }
  const retry = useBranchAutoRenameRetry({
    open,
    worktreeId,
    executionHostId,
    onRenamed: () => onOpenChange(false),
    onAttemptFinished: (outcome) => {
      const dialog = (tryAgainRef.current ?? dismissRef.current)?.closest('[role="dialog"]')
      if (!dialog?.contains(document.activeElement)) {
        return
      }
      const target = outcome.kind === 'ineligible' ? dismissRef : tryAgainRef
      const focusedAtFinish = document.activeElement
      const sessionAtFinish = openSession.current.count
      requestAnimationFrame(() => {
        // Re-validate at run time: the dialog may have closed or reopened, or the user moved focus.
        const button = target.current
        const active = document.activeElement
        if (
          button &&
          openSession.current.count === sessionAtFinish &&
          openSession.current.open &&
          dialog.isConnected &&
          // A closing dialog stays connected through its exit animation.
          dialog.getAttribute('data-state') === 'open' &&
          button.closest('[role="dialog"]') === dialog &&
          // Unchanged, or dropped because the focused Try again just unmounted: Radix moves focus to
          // the dialog container (body elsewhere).
          (active === focusedAtFinish || active === document.body || active === dialog)
        ) {
          button.focus()
        }
      })
    }
  })
  const dismissLabel = t('auto.components.sidebar.AutoRenameFailedDialog.dismiss', 'Dismiss')
  const dismissingLabel = t(
    'auto.components.sidebar.AutoRenameFailedDialog.dismissing',
    'Dismissing…'
  )
  const tryAgainLabel = t('auto.components.sidebar.AutoRenameFailedDialog.tryAgain', 'Try again')
  const namingLabel = t(
    'auto.components.sidebar.AutoRenameFailedDialog.namingBranch',
    'Naming branch…'
  )
  const handleDismiss = async () => {
    setDismissing(true)
    try {
      const result = await updateWorktreeMeta(
        worktreeId,
        { firstAgentMessageRenameError: null },
        { executionHostId: executionHostId ?? 'local' }
      )
      if (result.ok) {
        onOpenChange(false)
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDismissing(false)
    }
  }
  // Each finished attempt rereads the output, even when its error text is unchanged.
  const readFullOutput = useMemo(
    () =>
      recomputeOn(
        [retry.finishedCount],
        () => () => window.api.worktrees.getBranchRenameFailureOutput({ worktreeId })
      ),
    [worktreeId, retry.finishedCount]
  )
  // A final result means the name was kept on purpose, not that something failed.
  const kept = retry.lastOutcome?.kind === 'ineligible'
  const showTryAgain = retry.availability !== 'unavailable' && !kept
  return (
    <AgentCommandFailedDialog
      open={open}
      error={shownError}
      onOpenChange={onOpenChange}
      tone={kept ? 'neutral' : 'error'}
      title={
        kept
          ? t('auto.components.sidebar.AutoRenameFailedDialog.branchNameKept', 'Branch name kept')
          : t(
              'auto.components.sidebar.AutoRenameFailedDialog.ca3b225195',
              'Branch auto-name failed'
            )
      }
      description={
        <Trans
          i18n={i18n}
          defaults={t(
            'auto.components.sidebar.AutoRenameFailedDialog.couldNotGenerateBranchName',
            "Orca couldn't generate a branch name for <name>{{name}}</name> from the first agent message."
          )}
          values={{ name: worktreeName }}
          components={{ name: <span className="font-medium text-foreground" /> }}
        />
      }
      readFullOutput={readFullOutput}
      showFooterClose={false}
      reason={branchAutoRenameReasonText(retry.lastOutcome, t)}
      detailsFinishedAt={retry.lastFinishedAt}
      announcementPaused={retry.running}
      action={
        <>
          <Button
            ref={dismissRef}
            type="button"
            variant="outline"
            size="sm"
            disabled={dismissing || retry.running}
            aria-busy={dismissing}
            aria-label={dismissing ? dismissingLabel : dismissLabel}
            onClick={handleDismiss}
          >
            <SwapLabel busy={dismissing} idle={dismissLabel} busyLabel={dismissingLabel} />
          </Button>
          {showTryAgain ? (
            <Button
              ref={tryAgainRef}
              type="button"
              size="sm"
              // Pending availability reserves the slot so the footer does not shift or flash.
              className={retry.availability === 'pending' ? 'invisible' : undefined}
              tabIndex={retry.availability === 'pending' ? -1 : undefined}
              aria-hidden={retry.availability === 'pending' || undefined}
              aria-disabled={retry.running || retry.availability === 'pending' || undefined}
              aria-busy={retry.running}
              aria-label={retry.running ? namingLabel : tryAgainLabel}
              onClick={() => {
                if (!retry.running && retry.availability === 'available') {
                  retry.tryAgain()
                }
              }}
            >
              {retry.running ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              <SwapLabel busy={retry.running} idle={tryAgainLabel} busyLabel={namingLabel} />
            </Button>
          ) : null}
        </>
      }
    />
  )
}
