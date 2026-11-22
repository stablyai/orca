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
      <span className="text-xs font-medium text-muted-foreground">
        {t('auto.components.settings.serverList.serversCaption', 'Servers')}
      </span>
      <div aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
        {running ? (
          // The status bar's update segment reopens the progress dialog.
          <span className="flex items-center gap-1.5">
            <LoadingSpinner className="size-3" />
            {t('auto.components.settings.serverList.updatingShort', 'Updating…')}
          </span>
        ) : availableCount >= 2 ? (
          // One update already takes one click on its own row.
          <>
            <span>
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
              {t('auto.components.settings.serverList.updateAllShort', 'Update all')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
