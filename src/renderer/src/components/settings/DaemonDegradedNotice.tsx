import { TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

/**
 * Degraded mode used to be rare and transient, so a console warning was enough. It is now the
 * settled outcome for a daemon the launcher could not classify — it holds one rather than
 * killing terminals it might still be hosting — which makes it permanent until the user acts.
 *
 * This surfaces it beside the Restart action that resolves it. It does not surface it anywhere
 * a user who has not opened Settings would see; a status-bar indicator is the obvious next step.
 */
export function DaemonDegradedNotice(props: {
  degraded: boolean
  isBusy: boolean
  onRestartDaemon: () => void
}): React.JSX.Element | null {
  if (!props.degraded) {
    return null
  }

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-amber-700 dark:text-amber-300"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.settings.DaemonDegradedNotice.title',
              'New terminals aren’t being saved'
            )}
          </p>
          <p className="text-xs leading-snug">
            {translate(
              'auto.components.settings.DaemonDegradedNotice.body',
              'The terminal host stopped responding. Orca kept it rather than ending anything it might still be hosting, but it can’t reach those terminals until the host responds again — reopening a pane retries, and works once it does. New terminals open outside the host and close when you quit Orca. Restarting the host usually clears this, and ends every terminal — both the ones it is still holding and the ones running outside it.'
            )}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={props.isBusy}
        onClick={props.onRestartDaemon}
      >
        {translate('auto.components.settings.DaemonDegradedNotice.action', 'Restart host')}
      </Button>
    </div>
  )
}
