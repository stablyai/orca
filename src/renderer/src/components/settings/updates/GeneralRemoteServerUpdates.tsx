import type React from 'react'
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { getRemoteServerNewerThanClientVersion } from '@/runtime/hosts/updates/remote-server-version-skew'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { getRemoteServerUpdatePhaseLabel } from '../runtime-environments/updates/RemoteServerUpdateStatus'
import {
  getRemoteServerEntryHelp,
  getRemoteServerVersionDescription
} from '../runtime-environments/updates/remote-server-update-entry-copy'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { AboutDisclosureRow } from './AboutDisclosureRow'

const isEligible = (entry: RemoteServerUpdateEntry): boolean =>
  entry.phase === 'available' || entry.phase === 'failed'

function serverSummaryParts(entries: RemoteServerUpdateEntry[], t: Translate): string[] {
  const count = (phase: RemoteServerUpdateEntry['phase']): number =>
    entries.filter((entry) => entry.phase === phase).length
  const available = entries.filter(isEligible).length
  const settled = entries.filter((entry) => entry.phase === 'current' || entry.phase === 'updated')
  // A newer server needs nothing from its own updater; this app is the one behind.
  const newer = settled.filter((entry) => getRemoteServerNewerThanClientVersion(entry)).length
  const current = settled.length - newer
  const parts = [
    available > 0
      ? t('settings.about.servers.readyCount', '{{value0}} ready', { value0: available })
      : null,
    current > 0
      ? t(
          'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
          '{{value0}} up to date',
          { value0: current }
        )
      : null,
    newer > 0
      ? t(
          'auto.components.settings.GeneralRemoteServerUpdates.newerCount',
          '{{value0}} newer than this app',
          { value0: newer }
        )
      : null,
    count('manual') > 0
      ? t('auto.components.settings.GeneralRemoteServerUpdates.manualCount', '{{value0}} manual', {
          value0: count('manual')
        })
      : null,
    count('offline') > 0
      ? t(
          'auto.components.settings.GeneralRemoteServerUpdates.offlineCount',
          '{{value0}} offline',
          { value0: count('offline') }
        )
      : null
  ].filter((part): part is string => part !== null)
  if (parts.length > 0) {
    return parts
  }
  return [
    entries.length === 1
      ? t('auto.components.settings.GeneralRemoteServerUpdates.serverCountOne', '1 paired server')
      : t(
          'auto.components.settings.GeneralRemoteServerUpdates.serverCount',
          '{{value0}} paired servers',
          { value0: entries.length }
        )
  ]
}

/** All counts, or only the first when the row is too narrow to show them on one line. */
function ServerSummary({ parts }: { parts: string[] }): React.JSX.Element {
  return (
    <>
      <span className={parts.length > 1 ? '@max-xs/about-row:hidden' : undefined}>
        {parts.join(' · ')}
      </span>
      {parts.length > 1 ? (
        <span className="hidden @max-xs/about-row:inline">{parts[0]}</span>
      ) : null}
    </>
  )
}

export function GeneralRemoteServerUpdates(): React.JSX.Element | null {
  const t = useTranslate()
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const entries = [...entryMap.values()]
  const checking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const refresh = useAppStore((state) => state.refreshRemoteServerUpdates)
  const start = useAppStore((state) => state.startRemoteServerUpdates)
  const [open, setOpen] = useState(false)

  if (entries.length === 0) {
    return null
  }

  const eligible = entries.filter(isEligible)
  const liveTabCount = eligible.reduce((total, entry) => total + entry.liveTabCount, 0)
  const liveLeafCount = eligible.reduce((total, entry) => total + entry.liveLeafCount, 0)
  const busy = checking || running

  const action = running ? (
    <Button type="button" variant="outline" size="sm" disabled>
      <Loader2 className="animate-spin" />
      {t('settings.about.servers.updating', 'Updating')}
    </Button>
  ) : eligible.length > 0 && !checking ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        setOpen(true)
        void start()
      }}
    >
      {eligible.length === 1
        ? t('settings.about.action.update', 'Update')
        : t('settings.about.servers.updateAll', 'Update all')}
    </Button>
  ) : (
    <Button
      type="button"
      variant="outline"
      size="sm"
      title={getUpdateCheckHint()}
      disabled={busy}
      onClick={(event) => {
        setOpen(true)
        void refresh(getUpdateCheckClickOptions(event))
      }}
    >
      {checking ? <Loader2 className="animate-spin" /> : null}
      {t('settings.about.action.check', 'Check')}
    </Button>
  )

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
    >
      <AboutDisclosureRow
        label={t('settings.about.servers.title', 'Servers')}
        summary={<ServerSummary parts={serverSummaryParts(entries, t)} />}
        open={open}
        onOpenChange={setOpen}
        control={action}
      >
        {eligible.length > 0 && (liveTabCount > 0 || liveLeafCount > 0) ? (
          <p data-settings-row="" className="text-settings-detail text-muted-foreground">
            {t(
              'auto.components.settings.RemoteServerUpdateDialog.restartWarning',
              'Updating restarts these servers. {{value0}} and {{value1}} may briefly disconnect.',
              {
                value0:
                  liveTabCount === 1
                    ? t(
                        'auto.components.settings.RemoteServerUpdateDialog.liveTabOne',
                        '1 live tab'
                      )
                    : t(
                        'auto.components.settings.RemoteServerUpdateDialog.liveTabs',
                        '{{value0}} live tabs',
                        { value0: liveTabCount }
                      ),
                value1:
                  liveLeafCount === 1
                    ? t(
                        'auto.components.settings.RemoteServerUpdateDialog.livePaneOne',
                        '1 live pane'
                      )
                    : t(
                        'auto.components.settings.RemoteServerUpdateDialog.livePanes',
                        '{{value0}} live panes',
                        { value0: liveLeafCount }
                      )
              }
            )}
          </p>
        ) : null}
        {entries.map((entry) => (
          <RemoteServerAboutRow
            key={entry.environmentId}
            entry={entry}
            disabled={busy}
            onUpdate={() => void start([entry.environmentId])}
          />
        ))}
      </AboutDisclosureRow>
    </SearchableSetting>
  )
}

function statusDotClass(entry: RemoteServerUpdateEntry): string {
  switch (entry.phase) {
    case 'available':
      return 'bg-theme-accent'
    case 'current':
    case 'updated':
      return 'bg-status-success'
    case 'manual':
      return 'bg-status-warning'
    case 'failed':
      return 'bg-destructive'
    case 'offline':
      return 'border border-muted-foreground'
    default:
      return 'bg-muted-foreground'
  }
}

const BUSY_PHASES = new Set<RemoteServerUpdateEntry['phase']>([
  'checking',
  'queued',
  'checking-update',
  'downloading',
  'restarting'
])

function RemoteServerAboutRow({
  entry,
  disabled,
  onUpdate
}: {
  entry: RemoteServerUpdateEntry
  disabled: boolean
  onUpdate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const help = getRemoteServerEntryHelp(entry, t)
  const sub = help ?? getRemoteServerVersionDescription(entry, t)
  const busy = BUSY_PHASES.has(entry.phase)
  const status =
    entry.phase === 'downloading' && entry.progress !== null
      ? `${Math.round(entry.progress)}%`
      : getRemoteServerUpdatePhaseLabel(entry.phase, t)
  return (
    <div data-settings-row="" className="flex items-center gap-3">
      <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
        {busy ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : (
          <span className={cn('size-2 rounded-full', statusDotClass(entry))} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{entry.name}</div>
        <div
          title={sub}
          // Static strings: cn() would merge the size token away as a text colour.
          className={
            entry.phase === 'failed'
              ? 'truncate text-settings-detail text-destructive'
              : 'truncate text-settings-detail text-muted-foreground'
          }
        >
          {sub}
        </div>
      </div>
      {entry.phase === 'available' || entry.phase === 'failed' ? (
        <Button type="button" variant="outline" size="xs" onClick={onUpdate} disabled={disabled}>
          {entry.phase === 'failed'
            ? t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
            : t('settings.about.action.update', 'Update')}
        </Button>
      ) : (
        <span className="shrink-0 text-settings-detail text-muted-foreground tabular-nums">
          {status}
        </span>
      )}
    </div>
  )
}
