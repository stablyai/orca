import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'

type AgentCommandFailedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The published failure message, shown when no full output is available. */
  error: string
  /** Full CLI output still held in memory; null falls back to `error`. Keep it stable. */
  readFullOutput?: () => Promise<string | null>
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
  /** Lets an action that moves elsewhere (Settings) keep focus from returning to the trigger. */
  onCloseAutoFocus?: (event: Event) => void
  /** The dialog's own content element, so a caller can tell its focus apart from another modal's. */
  contentRef?: Ref<HTMLDivElement>
}

/** A failed agent command: what ran, its output with Copy, and the caller's next step. */
export function AgentCommandFailedDialog({
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
  announcementPaused = false,
  onCloseAutoFocus,
  contentRef
}: AgentCommandFailedDialogProps): React.JSX.Element {
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
    if (!open || !readFullOutput) {
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
      <DialogContent ref={contentRef} className="sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
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
        {/* One right-aligned row that wraps as a unit; the default stacks full-width buttons when narrow.
            No buttons, no footer: an empty one leaves a dead band under the content. */}
        {showFooterClose || action ? (
          <DialogFooter className="flex-row flex-wrap justify-end">
            {showFooterClose ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t('auto.components.sidebar.AutoRenameFailedDialog.aed1623b1e', 'Close')}
              </Button>
            ) : null}
            {action}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
