import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type AutoRenameFailedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Worktree whose auto-rename failed; keys the full-output lookup. */
  worktreeId: string
  /** Sidebar name of the worktree whose auto-rename failed. */
  worktreeName: string
  /** Persisted failure message — headline plus a sanitized output excerpt. */
  error: string
}

export function AutoRenameFailedDialog({
  worktreeId,
  worktreeName,
  ...props
}: AutoRenameFailedDialogProps): React.JSX.Element {
  const readFullOutput = useCallback(
    () => window.api.worktrees.getBranchRenameFailureOutput({ worktreeId }),
    [worktreeId]
  )
  return (
    <NameGenerationFailedDialog
      {...props}
      title={translate(
        'auto.components.sidebar.AutoRenameFailedDialog.ca3b225195',
        'Branch auto-name failed'
      )}
      description={
        <>
          {translate(
            'auto.components.sidebar.AutoRenameFailedDialog.ff62a18580',
            "Orca couldn't generate a branch name for"
          )}{' '}
          <span className="font-medium text-foreground">{worktreeName}</span>{' '}
          {translate(
            'auto.components.sidebar.AutoRenameFailedDialog.3afcad0497',
            'from the first agent message.'
          )}
        </>
      }
      readFullOutput={readFullOutput}
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
  /** A footer action beside Close, such as running the generation again. */
  action?: ReactNode
}

/**
 * Modal that surfaces a name-generation failure. It shows the full
 * CLI output when main still holds it (in-memory, lost on restart), falling
 * back to the published excerpt — either can run many lines, so it gets a
 * dedicated scrollable surface rather than a tooltip — see the sibling
 * AddRemoteHostDialog pattern.
 */
export function NameGenerationFailedDialog({
  open,
  onOpenChange,
  title,
  description,
  error,
  readFullOutput,
  action
}: NameGenerationFailedDialogProps): React.JSX.Element {
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

  const handleCopy = useCallback(async () => {
    try {
      // Why: Electron's clipboard IPC, not navigator.clipboard, which fails
      // silently inside Radix dialogs — and an inline icon swap (no toast),
      // matching the app's other inline copy buttons.
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
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{description}</p>
        {/* Why: agent-CLI output is literal and often multi-line, so render it
            verbatim (mono, wrapped) inside a height-capped scroll region.
            min-w-0 keeps an unbroken token from widening this grid column. */}
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.sidebar.AutoRenameFailedDialog.74fc00776f',
              'Error details'
            )}
          </p>
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleCopy}
              aria-label={
                copied
                  ? translate('auto.components.sidebar.AutoRenameFailedDialog.a23b22d16f', 'Copied')
                  : translate(
                      'auto.components.sidebar.AutoRenameFailedDialog.eab8b45238',
                      'Copy error'
                    )
              }
              // Why: float over the scroll region's top-right; pad the text so
              // long lines never slide under the button.
              className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
            <pre className="scrollbar-sleek max-h-[40vh] overflow-auto rounded-md border border-border/60 bg-muted/40 py-3 pl-3 pr-9 font-mono text-[11px] leading-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
              {detailText}
            </pre>
          </div>
        </div>
        <DialogFooter>
          {/* Why: Close backs the user out, so it stays quiet (outline, not a
              solid CTA) — matching the other sidebar dialogs. */}
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.sidebar.AutoRenameFailedDialog.aed1623b1e', 'Close')}
          </Button>
          {action}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
