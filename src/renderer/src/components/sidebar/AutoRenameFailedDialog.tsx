import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** Sidebar name of the worktree whose auto-rename failed. */
  worktreeName: string
  /** Full failure message — usually formatted agent-CLI output (multi-line). */
  error: string
}

/**
 * Modal that surfaces the full auto-rename generation failure. The message is
 * raw agent-CLI output that can run many lines, so it gets a dedicated scrollable
 * surface rather than a tooltip — see the sibling SshDisconnectedDialog pattern.
 */
export function AutoRenameFailedDialog({
  open,
  onOpenChange,
  worktreeName,
  error
}: AutoRenameFailedDialogProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current)
      }
    }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      // Why: Electron's clipboard IPC, not navigator.clipboard, which fails
      // silently inside Radix dialogs — and an inline icon swap (no toast),
      // matching the app's other inline copy buttons.
      await window.api.ui.writeClipboardText(error)
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
  }, [error])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {translate(
              'auto.components.sidebar.AutoRenameFailedDialog.ca3b225195',
              'Branch auto-name failed'
            )}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.sidebar.AutoRenameFailedDialog.ff62a18580',
            "Orca couldn't generate a branch name for"
          )}{' '}
          <span className="font-medium text-foreground">{worktreeName}</span>{' '}
          {translate(
            'auto.components.sidebar.AutoRenameFailedDialog.3afcad0497',
            'from the first agent message.'
          )}
        </p>
        {/* Why: agent-CLI output is literal and often multi-line, so render it
            verbatim (mono, wrapped) inside a height-capped scroll region. */}
        <div className="space-y-1.5">
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
            <pre className="scrollbar-sleek max-h-[40vh] overflow-auto rounded-md border border-border/60 bg-muted/40 py-3 pl-3 pr-9 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-foreground">
              {error}
            </pre>
          </div>
        </div>
        <DialogFooter>
          {/* Why: Close backs the user out, so it stays quiet (outline, not a
              solid CTA) — matching the sibling SshDisconnectedDialog. */}
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.sidebar.AutoRenameFailedDialog.aed1623b1e', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
