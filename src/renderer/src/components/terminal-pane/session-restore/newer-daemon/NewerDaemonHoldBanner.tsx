import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { PaneTopWarningBanner } from '../../appearance/pane-top-banner/PaneTopWarningBanner'
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
  const t = useTranslate()
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
          ? t('terminal.newerDaemonBanner.failedTitle', "Couldn't reopen this terminal")
          : t(
              'terminal.newerDaemonBanner.title',
              'This terminal was opened in a newer version of Orca'
            )
      }
      body={
        !failed && hold.resumable
          ? t(
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
      }
      onDismiss={reopening ? undefined : () => dismissHeldPaneBanner(paneKey)}
    />
  )
}
