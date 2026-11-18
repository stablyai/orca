import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { AlertCircle, Check, Copy, LoaderCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { cn } from '@/lib/class-names'
import { recomputeOn } from '@/lib/recompute-on'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
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
    <NameGenerationFailedDialog
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

type NameGenerationFailedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The published failure message, shown when no full output is available. */
  error: string
  /** Full CLI output still held in memory; null falls back to `error`. Keep it stable. */
  readFullOutput: () => Promise<string | null>
  action?: ReactNode
  /** False drops the footer Close button; × and Esc still close. */
  showFooterClose?: boolean
  /** A retry's one-line reason: replaces the body line and hides the error details. */
  reason?: string | null
  /** Neutral drops the red alert treatment when nothing failed (a kept name). */
  tone?: 'error' | 'neutral'
  /** When the latest retry finished; stamps the label so identical errors still read as new. */
  detailsFinishedAt?: number | null
  /** Empties the live region while an attempt runs, so an identical result is announced again. */
  announcementPaused?: boolean
}

/** Full output is memory-only; fall back to the published excerpt after restart and scroll long replies. */
export function NameGenerationFailedDialog({
  open,
  onOpenChange,
  title,
  description,
  error,
  readFullOutput,
  action,
  showFooterClose = true,
  reason = null,
  tone = 'error',
  detailsFinishedAt = null,
  announcementPaused = false
}: NameGenerationFailedDialogProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [copied, setCopied] = useState(false)
  const [fullOutput, setFullOutput] = useState<string | null>(null)
  const copiedResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    let stale = false
    setFullOutput(null)
    readFullOutput()
      .then((output) => {
        if (!stale) {
          setFullOutput(output)
        }
      })
      .catch(() => {
        if (!stale) {
          setFullOutput(null)
        }
      })
    return () => {
      stale = true
    }
  }, [error, open, readFullOutput])

  const detailText = fullOutput ?? error
  const detailsLabel =
    detailsFinishedAt === null
      ? t('auto.components.sidebar.AutoRenameFailedDialog.74fc00776f', 'Error details')
      : t(
          'auto.components.sidebar.AutoRenameFailedDialog.errorDetailsAt',
          'Error details · {{time}}',
          {
            time: uiDateTimeFormat({ hour: 'numeric', minute: '2-digit' }, intlLocale).format(
              detailsFinishedAt
            )
          }
        )
  // Announce the reason, or the label and first error line; never the full output.
  const announcement =
    detailsFinishedAt === null || announcementPaused
      ? ''
      : (reason ?? `${detailsLabel}. ${error.split('\n')[0] ?? ''}`)

  const handleCopy = useCallback(async () => {
    try {
      // Use Electron clipboard IPC because navigator.clipboard fails silently in Radix dialogs.
      await window.api.ui.writeClipboardText(detailText)
      setCopied(true)
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current)
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        copiedResetTimerRef.current = null
        setCopied(false)
      }, 1500)
    } catch {
      /* best-effort */
    }
  }, [detailText])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <span className={cn('flex items-center gap-2', tone === 'error' && 'text-destructive')}>
              {tone === 'error' ? <AlertCircle className="size-4 shrink-0" /> : null}
              {title}
            </span>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{reason ?? description}</p>
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
        {/* Cap and wrap literal CLI output; min-w-0 prevents unbroken tokens widening the grid. */}
        {reason === null ? (
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium text-foreground">{detailsLabel}</p>
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={handleCopy}
                aria-label={
                  copied
                    ? t('auto.components.sidebar.AutoRenameFailedDialog.a23b22d16f', 'Copied')
                    : t('auto.components.sidebar.AutoRenameFailedDialog.eab8b45238', 'Copy error')
                }
                className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
              <pre className="scrollbar-sleek max-h-[40vh] overflow-auto rounded-md border border-border/60 bg-muted/40 py-3 pl-3 pr-9 font-mono text-[11px] leading-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
                {detailText}
              </pre>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {showFooterClose ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('auto.components.sidebar.AutoRenameFailedDialog.aed1623b1e', 'Close')}
            </Button>
          ) : null}
          {action}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
