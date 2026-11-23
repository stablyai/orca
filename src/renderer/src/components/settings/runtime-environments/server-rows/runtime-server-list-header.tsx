import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import { Button } from '../../../ui/button'

/** Caption above the server list; holds the bulk Update all once two or more servers have one. */
export function RuntimeServerListHeader(): React.JSX.Element {
  const t = useTranslate()
  const remoteServerUpdates = useAppStore((state) => state.remoteServerUpdates)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const setRemoteServerUpdateDialogOpen = useAppStore(
    (state) => state.setRemoteServerUpdateDialogOpen
  )
  let availableCount = 0
  for (const entry of remoteServerUpdates.values()) {
    if (entry.phase === 'available') {
      availableCount += 1
    }
  }

  return (
    <div
      data-settings-section="remote-server-updates"
      className="flex min-h-6 scroll-mt-8 items-center justify-between gap-2"
    >
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {t('auto.components.settings.serverList.serversCaption', 'Servers')}
      </span>
      <div
        aria-live="polite"
        className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
      >
        {running ? (
          <Button
            type="button"
            variant="link-muted"
            size="inlineText"
            aria-haspopup="dialog"
            aria-label={t(
              'auto.components.status.bar.RemoteServerUpdateStatusSegment.updatingTooltip',
              'Remote Orca Server updates are in progress'
            )}
            onClick={() => setRemoteServerUpdateDialogOpen(true)}
          >
            <LoadingSpinner className="size-3" />
            {t('auto.components.settings.RuntimeEnvironmentsPane.updatingServers', 'Updating…')}
          </Button>
        ) : availableCount >= 2 ? (
          // One update already takes one click on its own row.
          <>
            <span className="truncate">
              {t('auto.components.settings.serverList.updatesCount', '{{count}} updates', {
                count: availableCount
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setRemoteServerUpdateDialogOpen(true)}
            >
              {t('auto.components.settings.serverList.updateAll', 'Update all')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
