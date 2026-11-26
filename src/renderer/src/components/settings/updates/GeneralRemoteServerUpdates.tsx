import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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

type SummaryPart = { text: string; count: number }

function serverSummaryParts(entries: RemoteServerUpdateEntry[], t: Translate): SummaryPart[] {
  const count = (phase: RemoteServerUpdateEntry['phase']): number =>
    entries.filter((entry) => entry.phase === phase).length
  const available = entries.filter(isEligible).length
  const settled = entries.filter((entry) => entry.phase === 'current' || entry.phase === 'updated')
  // A newer server needs nothing from its own updater; this app is the one behind.
  const newer = settled.filter((entry) => getRemoteServerNewerThanClientVersion(entry)).length
  const current = settled.length - newer
  const manual = count('manual')
  const offline = count('offline')
  const parts: SummaryPart[] = [
    {
      count: available,
      text: t('settings.about.servers.readyCount', '{{value0}} ready', { value0: available })
    },
    {
      count: current,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.currentCount',
        '{{value0}} up to date',
        { value0: current }
      )
    },
    {
      count: newer,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.newerCount',
        '{{value0}} newer than this app',
        { value0: newer }
      )
    },
    {
      count: manual,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.manualCount',
        '{{value0}} manual',
        {
          value0: manual
        }
      )
    },
    {
      count: offline,
      text: t(
        'auto.components.settings.GeneralRemoteServerUpdates.offlineCount',
        '{{value0}} offline',
        { value0: offline }
      )
    }
  ].filter((part) => part.count > 0)
  if (parts.length > 0) {
    return parts
  }
  return [
    {
      count: entries.length,
      text:
        entries.length === 1
          ? t(
              'auto.components.settings.GeneralRemoteServerUpdates.serverCountOne',
              '1 paired server'
            )
          : t(
              'auto.components.settings.GeneralRemoteServerUpdates.serverCount',
              '{{value0}} paired servers',
              { value0: entries.length }
            )
    }
  ]
}

/** All counts; when narrow, the first count plus the rest folded into "N other" so none disappear. */
function ServerSummary({ parts }: { parts: SummaryPart[] }): React.JSX.Element {
  const t = useTranslate()
  const [first, ...rest] = parts
  const other = rest.reduce((total, part) => total + part.count, 0)
  return (
    <>
      <span className={rest.length > 0 ? '@max-xs/about-row:hidden' : undefined}>
        {parts.map((part) => part.text).join(' · ')}
      </span>
      {rest.length > 0 ? (
        <span className="hidden @max-xs/about-row:inline">
          {first.text}
          {' · '}
          {t('settings.about.servers.otherCount', '{{value0}} other', { value0: other })}
        </span>
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
  const setDialogOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const [open, setOpen] = useState(false)
  // Opening owes a default-track re-check; it waits for any in-flight (possibly modifier) check,
  // and updates stay off until one succeeds, so a confirm never acts on a stale or one-off
  // snapshot. A failed re-check keeps updates off; the header Check retries.
  const [snapshot, setSnapshot] = useState<'owed' | 'running' | 'ready' | 'failed'>('owed')
  const settleRefresh = useCallback((run: Promise<void>): void => {
    setSnapshot('running')
    run.then(
      () => setSnapshot('ready'),
      () => setSnapshot('failed')
    )
  }, [])
  useEffect(() => {
    if (!open || snapshot !== 'owed' || checking || running) {
      return
    }
    // refresh() returns early while another check or batch holds the store; leave it owed then.
    const store = useAppStore.getState()
    if (store.remoteServerUpdatesChecking || store.remoteServerUpdatesRunning) {
      return
    }
    settleRefresh(refresh())
  }, [open, snapshot, checking, running, refresh, settleRefresh])

  // A modifier-click Check picks a one-off release track; closing the dialog clears it, and so
  // does folding this list or leaving the page, so a later Update all can't inherit it.
  const clearCheckOptions = useCallback((): void => {
    if (!useAppStore.getState().remoteServerUpdateDialogOpen) {
      setDialogOpen(false)
    }
  }, [setDialogOpen])
  useEffect(() => clearCheckOptions, [clearCheckOptions])

  if (entries.length === 0) {
    return null
  }

  const eligible = entries.filter(isEligible)
  const busy = checking || running
  const updatesBlocked = busy || snapshot !== 'ready'
  const updateLabel =
    eligible.length === 1
      ? t('settings.about.action.update', 'Update')
      : t('settings.about.servers.updateAll', 'Update all')
  // Opening re-checks on the default track, as the dialog did, so targets and live-session
  // counts are never a stale snapshot from an earlier (possibly modifier) check.
  const setOpenAndRefresh = (next: boolean): void => {
    setOpen(next)
    setSnapshot('owed')
    if (!next) {
      clearCheckOptions()
    }
  }

  // Folded, an update only unfolds the list: updating restarts servers, so the targets and the
  // live-session warning show before the confirm, as the dialog did.
  const action = running ? (
    <Button type="button" variant="outline" size="sm" disabled>
      <Loader2 className="animate-spin" />
      {t('settings.about.servers.updating', 'Updating')}
    </Button>
  ) : eligible.length > 0 && !open && !checking ? (
    <Button type="button" variant="outline" size="sm" onClick={() => setOpenAndRefresh(true)}>
      {updateLabel}
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
        // An explicit Check is its own snapshot, including a modifier one the user asked for.
        settleRefresh(refresh(getUpdateCheckClickOptions(event)))
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
        onOpenChange={setOpenAndRefresh}
        control={action}
      >
        {open ? (
          <>
            {entries.map((entry) => (
              <RemoteServerAboutRow
                key={entry.environmentId}
                entry={entry}
                disabled={updatesBlocked}
                onUpdate={(ids) => void start(ids)}
              />
            ))}
            {eligible.length > 0 ? (
              <div data-settings-row="" className="flex items-center justify-end">
                <ServerRestartConfirm
                  servers={eligible}
                  label={updateLabel}
                  variant="default"
                  disabled={updatesBlocked}
                  onConfirm={(ids) => void start(ids)}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </AboutDisclosureRow>
    </SearchableSetting>
  )
}

/** Updating restarts servers, so every update asks once, naming what restarts and whether live sessions drop. */
function ServerRestartConfirm({
  servers,
  label,
  variant,
  disabled,
  onConfirm
}: {
  servers: RemoteServerUpdateEntry[]
  label: string
  variant: 'default' | 'outline'
  disabled: boolean
  /** Receives exactly the servers the question named. */
  onConfirm: (environmentIds: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = servers.map((entry) => entry.environmentId)
  const key = ids.join('\n')
  // Bound to the servers it named: if the set changes while open, the question closes unanswered.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Invalidation is durable: once the set changes or updates block, the question is dropped and
  // never reopens by itself.
  if (openKey !== null && (openKey !== key || disabled)) {
    setOpenKey(null)
  }
  const open = openKey === key && !disabled
  const live = servers.some((entry) => entry.liveTabCount > 0 || entry.liveLeafCount > 0)
  const question =
    servers.length === 1
      ? t('settings.about.servers.confirmOne', 'Restart {{name}}?', { name: servers[0].name })
      : t('settings.about.servers.confirmMany', 'Restart {{count}} servers?', {
          count: servers.length
        })
  return (
    <Popover open={open} onOpenChange={(next) => setOpenKey(next ? key : null)}>
      <PopoverTrigger asChild>
        <Button type="button" variant={variant} size="sm" disabled={disabled}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={question}
        className="w-auto max-w-[min(30rem,calc(100vw-1rem))]"
      >
        <div className="flex items-center gap-3 p-1.5 ps-3">
          <p className="min-w-0 text-sm">
            {question}
            {live ? ` ${t('settings.about.servers.liveMayDrop', 'Live sessions may drop.')}` : null}
          </p>
          {/* Focus starts on Cancel so a repeated or held Enter can't restart servers. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => setOpenKey(null)}
          >
            {t('settings.about.servers.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setOpenKey(null)
              onConfirm(ids)
            }}
          >
            {t('settings.about.action.update', 'Update')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
    // Busy phases draw a spinner instead of this dot.
    case 'checking':
    case 'checking-update':
    case 'downloading':
    case 'queued':
    case 'restarting':
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
  onUpdate: (environmentIds: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  // "Manual update" already says what to do; its long help would only be cut off here.
  const help = entry.phase === 'manual' ? null : getRemoteServerEntryHelp(entry, t)
  const version = getRemoteServerVersionDescription(entry, t)
  // Keep the version beside the help so a manual or failed server still says what it runs.
  const sub = help ? `${version} · ${help}` : version
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
          // A failure is the user's recovery instructions, so it wraps in full instead of truncating.
          className={
            entry.phase === 'failed'
              ? 'break-words text-settings-detail text-destructive'
              : 'truncate text-settings-detail text-muted-foreground'
          }
        >
          {sub}
        </div>
      </div>
      {entry.phase === 'available' || entry.phase === 'failed' ? (
        <ServerRestartConfirm
          servers={[entry]}
          label={
            entry.phase === 'failed'
              ? t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
              : t('settings.about.action.update', 'Update')
          }
          variant="outline"
          disabled={disabled}
          onConfirm={onUpdate}
        />
      ) : (
        <span className="shrink-0 text-settings-detail text-muted-foreground tabular-nums">
          {status}
        </span>
      )}
    </div>
  )
}
