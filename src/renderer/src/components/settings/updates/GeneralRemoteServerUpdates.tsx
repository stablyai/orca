import type React from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import { SearchableSetting } from '../section-layout/SearchableSetting'

export function GeneralRemoteServerUpdates(): React.JSX.Element | null {
  const t = useTranslate()
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const entries = [...entryMap.values()]
  const checking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const refresh = useAppStore((state) => state.refreshRemoteServerUpdates)
  const setDialogOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const updateCheckHint = getUpdateCheckHint()

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
      ? t('auto.components.settings.GeneralRemoteServerUpdates.serverCountOne', '1 paired server')
      : t(
          'auto.components.settings.GeneralRemoteServerUpdates.serverCount',
          '{{value0}} paired servers',
          { value0: entries.length }
        ),
    available > 0
      ? t(
          'auto.components.settings.GeneralRemoteServerUpdates.availableCount',
          '{{value0}} ready to update',
          { value0: available }
        )
      : null,
    current > 0
      ? t(
          'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
          '{{value0}} up to date',
          { value0: current }
        )
      : null,
    manual > 0
      ? t('auto.components.settings.GeneralRemoteServerUpdates.manualCount', '{{value0}} manual', {
          value0: manual
        })
      : null,
    offline > 0
      ? t(
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
      title={t(
        'auto.components.settings.GeneralRemoteServerUpdates.fdd271abf0',
        'Remote Orca servers'
      )}
      description={t(
        'auto.components.settings.GeneralRemoteServerUpdates.description',
        'Check and update paired Orca servers from this client.'
      )}
      keywords={['remote server', 'update all', 'paired', 'version']}
      className="space-y-3 py-3"
    >
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {t(
            'auto.components.settings.GeneralRemoteServerUpdates.fdd271abf0',
            'Remote Orca servers'
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
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
            ? t('auto.components.settings.GeneralRemoteServerUpdates.updating', 'Updating servers…')
            : t(
                'auto.components.settings.GeneralRemoteServerUpdates.e4e5937469',
                'Check for server updates'
              )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{summary}</p>
    </SearchableSetting>
  )
}
