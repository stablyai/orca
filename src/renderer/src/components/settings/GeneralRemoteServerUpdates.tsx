import type React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import { SearchableSetting } from './SearchableSetting'

export function GeneralRemoteServerUpdates(): React.JSX.Element | null {
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const entries = [...entryMap.values()]
  const checking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const refresh = useAppStore((state) => state.refreshRemoteServerUpdates)
  const setDialogOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const updateCheckHint = getUpdateCheckHint()

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (entries.length === 0) {
    return null
  }

  const available = entries.filter(
    (entry) => entry.phase === 'available' || entry.phase === 'failed'
  ).length
  const manual = entries.filter((entry) => entry.phase === 'manual').length
  const offline = entries.filter((entry) => entry.phase === 'offline').length
  const current = entries.filter(
    (entry) => entry.phase === 'current' || entry.phase === 'updated'
  ).length
  const summary = [
    entries.length === 1
      ? translate(
          'auto.components.settings.GeneralRemoteServerUpdates.serverCountOne',
          '1 paired server'
        )
      : translate(
          'auto.components.settings.GeneralRemoteServerUpdates.serverCount',
          '{{value0}} paired servers',
          { value0: entries.length }
        ),
    available > 0
      ? translate(
          'auto.components.settings.GeneralRemoteServerUpdates.availableCount',
          '{{value0}} ready to update',
          { value0: available }
        )
      : null,
    current > 0
      ? translate(
          'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
          '{{value0}} up to date',
          { value0: current }
        )
      : null,
    manual > 0
      ? translate(
          'auto.components.settings.GeneralRemoteServerUpdates.manualCount',
          '{{value0}} manual',
          { value0: manual }
        )
      : null,
    offline > 0
      ? translate(
          'auto.components.settings.GeneralRemoteServerUpdates.offlineCount',
          '{{value0}} offline',
          { value0: offline }
        )
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralRemoteServerUpdates.title',
        'Remote Orca Servers'
      )}
      description={translate(
        'auto.components.settings.GeneralRemoteServerUpdates.description',
        'Check and update paired Orca servers from this client.'
      )}
      keywords={['remote server', 'update all', 'paired', 'version']}
      className="space-y-3"
    >
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.settings.GeneralRemoteServerUpdates.title',
            'Remote Orca Servers'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GeneralRemoteServerUpdates.description',
            'Check and update paired Orca servers from this client.'
          )}
        </p>
      </div>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          title={updateCheckHint}
          disabled={checking || running}
          onClick={(event) => {
            setDialogOpen(true)
            void refresh(getUpdateCheckClickOptions(event))
          }}
        >
          {checking || running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {running
            ? translate(
                'auto.components.settings.GeneralRemoteServerUpdates.updating',
                'Updating servers…'
              )
            : translate(
                'auto.components.settings.GeneralRemoteServerUpdates.reviewServers',
                'Check for Server Updates'
              )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{summary}</p>
    </SearchableSetting>
  )
}
