import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { PaneTopWarningBanner } from './PaneTopWarningBanner'
import {
  dismissHeldPaneBanner,
  reopenHeldTerminals,
  useNewerDaemonHold
} from './newer-daemon-hold-state'

/** Shown on a restored pane held back because a newer Orca build's daemon may still run it. */
export function NewerDaemonHoldBanner({
  tabId,
  leafId
}: {
  tabId: string
  leafId: string
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, leafId)
  const hold = useNewerDaemonHold(paneKey)
  if (!hold) {
    return null
  }
  const reopening = hold.phase === 'reopening'
  const failed = hold.phase === 'failed'
  return (
    <PaneTopWarningBanner
      title={
        failed
          ? translate('terminal.newerDaemonBanner.failedTitle', "Couldn't reopen this terminal")
          : translate(
              'terminal.newerDaemonBanner.title',
              'This terminal was opened in a newer version of Orca'
            )
      }
      body={
        !failed && hold.resumable
          ? translate(
              'terminal.newerDaemonBanner.resumableBody',
              'Reopen it here to keep working. Your agent session will resume.'
            )
          : undefined
      }
      primaryAction={
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={reopening}
          onClick={() => void reopenHeldTerminals()}
        >
          {reopening ? <LoadingSpinner className="size-3" /> : null}
          {reopening
            ? translate('terminal.newerDaemonBanner.reopening', 'Reopening…')
            : failed
              ? translate('terminal.newerDaemonBanner.tryAgain', 'Try again')
              : translate(
                  'terminal.newerDaemonBanner.reopenTerminal',
                  'Reopen {{count}} terminals',
                  {
                    count: hold.heldCount
                  }
                )}
        </Button>
      }
      onDismiss={reopening ? undefined : () => dismissHeldPaneBanner(paneKey)}
    />
  )
}
