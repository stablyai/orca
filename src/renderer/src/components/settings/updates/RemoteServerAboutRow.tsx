import type React from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import { getRemoteServerUpdatePhaseLabel } from '../runtime-environments/updates/RemoteServerUpdateStatus'
import {
  getRemoteServerEntryHelp,
  getRemoteServerVersionDescription
} from '../runtime-environments/updates/remote-server-update-entry-copy'
import { ServerRestartConfirm } from './ServerRestartConfirm'

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

export function RemoteServerAboutRow({
  entry,
  disabled,
  onUpdate,
  focusAfterConfirm
}: {
  entry: RemoteServerUpdateEntry
  disabled: boolean
  onUpdate: (environmentIds: string[]) => void
  focusAfterConfirm: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // "Manual update" already says what to do; its long help would only be cut off here.
  const help = entry.phase === 'manual' ? null : getRemoteServerEntryHelp(entry, t)
  const version = getRemoteServerVersionDescription(entry, t)
  // Keep the version beside the help so a manual or failed server still says what it runs.
  const sub = help ? `${version} · ${help}` : version
  const shortVersion =
    entry.targetVersion && entry.targetVersion !== entry.currentVersion
      ? `→ ${entry.targetVersion}`
      : version
  const failed = entry.phase === 'failed'
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
        <div title={entry.name} className="truncate text-sm">
          {entry.name}
        </div>
        <div
          title={sub}
          // Static strings: cn() would merge the size token away as a text colour.
          // A failure is the user's recovery instructions, so it wraps in full instead of truncating.
          className={
            failed
              ? 'break-words text-settings-detail text-destructive @max-xs/about-servers:hidden'
              : 'truncate text-settings-detail text-muted-foreground @max-xs/about-servers:hidden'
          }
        >
          {sub}
        </div>
        <div
          title={sub}
          className={
            failed
              ? 'hidden break-words text-settings-detail text-destructive @max-xs/about-servers:block'
              : 'hidden break-words text-settings-detail text-muted-foreground @max-xs/about-servers:block'
          }
        >
          {failed && help ? `${shortVersion} · ${help}` : shortVersion}
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
          focusAfterConfirm={focusAfterConfirm}
        />
      ) : (
        <span className="shrink-0 text-settings-detail text-muted-foreground tabular-nums">
          {status}
        </span>
      )}
    </div>
  )
}
