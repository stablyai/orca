import type React from 'react'
import { useId } from 'react'
import { Check, CircleAlert, Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { getRemoteServerUpdatePhaseLabel } from '../runtime-environments/updates/RemoteServerUpdateStatus'
import {
  getRemoteServerEntryHelp,
  getRemoteServerVersionDescription
} from '../runtime-environments/updates/remote-server-update-entry-copy'
import { ServerRestartButton } from './ServerRestartButton'
import {
  UPDATING_PHASES,
  getServerRestartQuestion,
  getSessionsMayDropLabel
} from './server-restart-copy'

function statusDotClass(entry: RemoteServerUpdateEntry): string {
  switch (entry.phase) {
    case 'available':
      return 'bg-theme-accent'
    case 'current':
      return 'bg-status-success'
    case 'manual':
      return 'bg-status-warning'
    case 'offline':
      return 'border border-muted-foreground'
    // These phases draw a spinner, check or alert icon instead of this dot.
    case 'updated':
    case 'failed':
    case 'checking':
    case 'checking-update':
    case 'downloading':
    case 'queued':
    case 'restarting':
      return 'bg-muted-foreground'
  }
}

function StatusGlyph({ entry }: { entry: RemoteServerUpdateEntry }): React.JSX.Element {
  if (entry.phase === 'checking' || UPDATING_PHASES.has(entry.phase)) {
    return <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  }
  if (entry.phase === 'updated') {
    return <Check className="size-3.5 text-status-success" strokeWidth={2.5} />
  }
  if (entry.phase === 'failed') {
    return <CircleAlert className="size-3.5 text-destructive" />
  }
  return <span className={cn('size-2 rounded-full', statusDotClass(entry))} />
}

/** The right-hand status while a server needs no button; short so it never wraps at 256px. */
function statusText(entry: RemoteServerUpdateEntry, t: ReturnType<typeof useTranslate>): string {
  if (entry.phase === 'downloading' && entry.progress !== null) {
    return `${Math.round(entry.progress)}%`
  }
  // Preparing a download is still checking, as far as the row needs to say.
  if (entry.phase === 'checking-update') {
    return getRemoteServerUpdatePhaseLabel('checking', t)
  }
  // The check mark and new version already say it.
  return entry.phase === 'updated' ? '' : getRemoteServerUpdatePhaseLabel(entry.phase, t)
}

export function RemoteServerAboutRow({
  entry,
  armed,
  disabled,
  onArm,
  onDisarm,
  onConfirm
}: {
  entry: RemoteServerUpdateEntry
  armed: boolean
  /** Updates can't start right now (one is running, or the list's fresh check isn't in). */
  disabled: boolean
  onArm: () => void
  onDisarm: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const errorId = useId()
  const failed = entry.phase === 'failed'
  const help = getRemoteServerEntryHelp(entry, t)
  const version = getRemoteServerVersionDescription(entry, t)
  // Manual and restarting help are long sentences; the status on the right already says it.
  const sub =
    help && entry.phase !== 'manual' && entry.phase !== 'restarting' && !failed
      ? `${version} · ${help}`
      : version
  const progress =
    entry.phase === 'downloading' && entry.progress !== null
      ? Math.max(0, Math.min(100, Math.round(entry.progress)))
      : null
  const status = statusText(entry, t)

  let subtitle: React.ReactNode
  if (armed) {
    subtitle = (
      <div className="truncate text-settings-detail text-status-warning-text">
        {getSessionsMayDropLabel(t)}
      </div>
    )
  } else if (failed) {
    // One word keeps the row on one line; the full reason is in the tooltip and the Retry button's description.
    subtitle = (
      <div title={help ?? undefined} className="truncate text-settings-detail text-destructive">
        {t('settings.about.servers.failed', 'Failed')}
      </div>
    )
  } else {
    subtitle = (
      <div title={sub} className="truncate text-settings-detail text-muted-foreground">
        {sub}
      </div>
    )
  }

  return (
    // Narrow cards keep the control on the name line and give the subtitle the full width beneath
    // it, so a warning or version is never cut short by the button.
    <div
      data-settings-row=""
      className="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3"
    >
      <span
        aria-hidden
        className="col-start-1 row-start-1 row-end-3 grid size-3.5 place-items-center"
      >
        <StatusGlyph entry={entry} />
      </span>
      <div title={entry.name} className="col-start-2 row-start-1 truncate text-sm">
        {entry.name}
      </div>
      <div className="col-start-2 row-start-2 min-w-0 @max-xs/about-servers:col-end-4">
        {subtitle}
        {failed && help ? (
          <span id={errorId} className="sr-only">
            {help}
          </span>
        ) : null}
      </div>
      <div className="col-start-3 row-start-1 row-end-3 flex justify-end @max-xs/about-servers:row-end-2">
        {entry.phase === 'available' || failed ? (
          <ServerRestartButton
            label={
              failed
                ? t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
                : t('settings.about.action.update', 'Update')
            }
            armedLabel={t('settings.about.servers.restartOne', 'Restart?')}
            question={getServerRestartQuestion([entry], t)}
            armed={armed}
            disabled={disabled}
            confirmBlocked={disabled}
            target={entry.name}
            describedBy={failed && help ? errorId : undefined}
            onArm={onArm}
            onDisarm={onDisarm}
            onConfirm={onConfirm}
          />
        ) : status ? (
          <span className="shrink-0 whitespace-nowrap text-settings-detail text-muted-foreground tabular-nums">
            {status}
          </span>
        ) : null}
      </div>
      {progress !== null ? (
        // Rides the row's bottom edge under the text column, so the row never changes height.
        <div
          role="progressbar"
          aria-label={entry.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="absolute end-0 bottom-0 start-[calc(0.875rem+0.75rem)] h-0.5 overflow-hidden rounded-full bg-border"
        >
          <div
            className="h-full bg-theme-accent transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}
