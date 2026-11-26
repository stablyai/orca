import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { cn } from '@/lib/class-names'
import { recomputeOn } from '@/lib/recompute-on'
import { AgentCommandFailedDialog } from '@/components/agent-command-failure/AgentCommandFailedDialog'
import {
  branchNamingSettingsTarget,
  canOpenNamingSettings,
  isTransientNamingFailure,
  openNamingSettings
} from '@/components/agent-command-failure/naming-settings-link'
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
  const tryAgainRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Each open starts a session; queued focus from an earlier session or a closed dialog is void.
  const openSession = useRef({ count: 0, open })
  useLayoutEffect(() => {
    openSession.current = { count: openSession.current.count + 1, open }
  }, [open])
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
      // Anchor on this dialog's own content: Try again may already be gone (a kept name hides it),
      // and focus may sit in another modal, whose x must not take this result's focus.
      const dialog = dialogRef.current
      if (!dialog?.contains(document.activeElement)) {
        return
      }
      const focusedAtFinish = document.activeElement
      const sessionAtFinish = openSession.current.count
      requestAnimationFrame(() => {
        // A kept name leaves no footer buttons, so focus goes to the dialog's x.
        const button =
          outcome.kind === 'ineligible'
            ? dialog.querySelector<HTMLElement>('[data-slot="dialog-close"]')
            : tryAgainRef.current
        // Re-validate at run time: the dialog may have closed or reopened, or the user moved focus.
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
  const tryAgainLabel = t('auto.components.sidebar.AutoRenameFailedDialog.tryAgain', 'Try again')
  const namingLabel = t(
    'auto.components.sidebar.AutoRenameFailedDialog.namingBranch',
    'Naming branch…'
  )
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
  const reason = branchAutoRenameReasonText(retry.lastOutcome, t)
  // Only an error the naming agent's settings can fix; a reason line is not a failure to fix there.
  const showOpenSettings =
    reason === null &&
    canOpenNamingSettings(executionHostId) &&
    !isTransientNamingFailure(shownError)
  // Settings takes focus after the hand-off; the closing dialog must not pull it back to the card.
  const settingsHandoffRef = useRef(false)
  const openNamingSettingsFromDialog = () => {
    settingsHandoffRef.current = true
    // Close without clearing the error, so the card keeps it for Try again after the fix.
    onOpenChange(false)
    const { settings, repos } = useAppStore.getState()
    openNamingSettings(branchNamingSettingsTarget({ worktreeId, executionHostId, settings, repos }))
  }
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
      contentRef={dialogRef}
      readFullOutput={readFullOutput}
      showFooterClose={false}
      reason={reason}
      detailsFinishedAt={retry.lastFinishedAt}
      announcementPaused={retry.running}
      onCloseAutoFocus={(event) => {
        if (settingsHandoffRef.current) {
          settingsHandoffRef.current = false
          event.preventDefault()
        }
      }}
      // The x closes; it leaves the card's failure mark until a rename or a successful retry.
      action={
        showOpenSettings || showTryAgain ? (
          <>
            {showOpenSettings ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openNamingSettingsFromDialog}
              >
                {t('components.native-chat.install.openAgentSettings', 'Open Settings')}
              </Button>
            ) : null}
            {showTryAgain ? (
              <Button
                ref={tryAgainRef}
                type="button"
                size="sm"
                // Pending availability reserves the slot so the footer does not shift or flash.
                className={retry.availability === 'pending' ? 'invisible' : undefined}
                tabIndex={retry.availability === 'pending' ? -1 : undefined}
                aria-hidden={retry.availability === 'pending' || undefined}
                // aria-disabled, not disabled: a natively disabled button drops focus to the body,
                // and the focus hand-back after a result only runs while focus is inside the dialog.
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
        ) : null
      }
    />
  )
}
