import { RotateCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

/**
 * Recovery overlay shown when a worktree's sole terminal process exits on its
 * own (a failed startup such as a broken .envrc/direnv, a crash, or a reaped
 * session) rather than a deliberate clean `exit`. The pane stays mounted with
 * its last output visible behind the overlay so the worktree is never torn
 * down to the Landing screen; the user restarts in place or closes explicitly.
 */
export function TerminalDeadPaneOverlay({
  exitCode,
  onRestart,
  onClose
}: {
  exitCode: number
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  // Why: a clean exit (0) reads as "finished"; a non-zero/signal exit reads as
  // "failed" so the message matches what the user is recovering from.
  const failed = exitCode !== 0
  const title = failed
    ? translate('auto.components.terminal.pane.TerminalDeadPaneOverlay.failed', 'Terminal exited')
    : translate('auto.components.terminal.pane.TerminalDeadPaneOverlay.clean', 'Terminal closed')

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-end justify-center p-4">
      <div className="pointer-events-auto flex w-full max-w-[28rem] flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalDeadPaneOverlay.detail',
              'The shell process ended (exit code {{code}}). The output above is preserved.'
            ).replace('{{code}}', String(exitCode))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <X />
            {translate('auto.components.terminal.pane.TerminalDeadPaneOverlay.close', 'Close')}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={onRestart}>
            <RotateCw />
            {translate('auto.components.terminal.pane.TerminalDeadPaneOverlay.restart', 'Restart')}
          </Button>
        </div>
      </div>
    </div>
  )
}
