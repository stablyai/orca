import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { PaneTopWarningBanner } from '../../appearance/pane-top-banner/PaneTopWarningBanner'
import {
  dismissHeldPaneBanner,
  reopenHeldTerminals,
  retryHeldPane,
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
  const t = useTranslate()
  const paneKey = makePaneKey(tabId, leafId)
  const hold = useNewerDaemonHold(paneKey)
  if (!hold) {
    return null
  }
  const reopening = hold.phase === 'reopening'
  const failed = hold.phase === 'failed'
  // Why: Reopen stops the newer build's terminals, which the user would not expect from the label alone.
  const consequence = hold.canReopen
    ? t(
        'terminal.newerDaemonBanner.reopenStopsNewer',
        'Reopening stops every terminal still running in the newer version. To keep them, open the newer version instead.'
      )
    : t(
        'terminal.newerDaemonBanner.reopenOnHost',
        "It may still be running in a newer version of Orca on the computer you're connected to. If Orca is open there, reopen it from that window; otherwise update Orca there. Then try again."
      )
  const resumeNote =
    hold.resumable && hold.canReopen
      ? t(
          'terminal.newerDaemonBanner.resumableBody',
          'Reopen it here to keep working. Your agent session will resume.'
        )
      : null
  return (
    <PaneTopWarningBanner
      title={
        failed
          ? t('terminal.newerDaemonBanner.failedTitle', "Couldn't reopen this terminal")
          : t(
              'terminal.newerDaemonBanner.title',
              'This terminal was opened in a newer version of Orca'
            )
      }
      body={!failed && resumeNote ? `${consequence} ${resumeNote}` : consequence}
      primaryAction={
        !hold.canReopen ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={reopening}
            onClick={() => void retryHeldPane(paneKey)}
          >
            {reopening ? <LoadingSpinner className="size-3" /> : null}
            {reopening
              ? t('terminal.newerDaemonBanner.retrying', 'Retrying…')
              : t('terminal.newerDaemonBanner.tryAgain', 'Try again')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={reopening}
            onClick={() => void reopenHeldTerminals(paneKey)}
          >
            {reopening ? <LoadingSpinner className="size-3" /> : null}
            {reopening
              ? t('terminal.newerDaemonBanner.reopening', 'Reopening…')
              : failed
                ? t('terminal.newerDaemonBanner.tryAgain', 'Try again')
                : t('terminal.newerDaemonBanner.reopenTerminal', 'Reopen {{count}} terminals', {
                    count: hold.heldCount,
                    defaultValue_one: 'Reopen terminal'
                  })}
          </Button>
        )
      }
      onDismiss={reopening ? undefined : () => dismissHeldPaneBanner(paneKey)}
    />
  )
}
