import type React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useAppStore } from '@/store'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { translate } from '@/i18n/i18n'
import {
  getRemoteServerManualUpdateHelp,
  RemoteServerUpdateStatus
} from './RemoteServerUpdateStatus'

function versionDescription(entry: RemoteServerUpdateEntry): string {
  if (entry.currentVersion && entry.targetVersion && entry.currentVersion !== entry.targetVersion) {
    return `${entry.currentVersion} → ${entry.targetVersion}`
  }
  if (entry.currentVersion) {
    return `v${entry.currentVersion}`
  }
  return translate(
    'auto.components.settings.RemoteServerUpdateDialog.versionUnavailable',
    'Version unavailable'
  )
}

function entryHelp(entry: RemoteServerUpdateEntry): string | null {
  if (entry.error) {
    return entry.error
  }
  if (entry.phase === 'manual') {
    return getRemoteServerManualUpdateHelp(entry)
  }
  if (entry.phase === 'restarting') {
    return translate(
      'auto.components.settings.RemoteServerUpdateDialog.restartingHelp',
      'Waiting for the replacement server to reconnect on the new version.'
    )
  }
  return null
}

function ServerUpdateRow({
  entry,
  disabled,
  onUpdate
}: {
  entry: RemoteServerUpdateEntry
  disabled: boolean
  onUpdate: () => void
}): React.JSX.Element {
  const canUpdate = entry.phase === 'available' || entry.phase === 'failed'
  const help = entryHelp(entry)
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{entry.name}</span>
            <RemoteServerUpdateStatus entry={entry} compact />
          </div>
          <p className="text-xs text-muted-foreground">{versionDescription(entry)}</p>
        </div>
        {canUpdate ? (
          <Button type="button" variant="outline" size="xs" onClick={onUpdate} disabled={disabled}>
            {entry.phase === 'failed'
              ? translate('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
              : translate(
                  'auto.components.settings.RemoteServerUpdateDialog.update',
                  'Update this server'
                )}
          </Button>
        ) : null}
      </div>
      {entry.phase === 'downloading' && entry.progress !== null ? (
        <Progress
          value={entry.progress}
          aria-label={translate(
            'auto.components.settings.RemoteServerUpdateDialog.downloadProgress',
            '{{value0}} download progress',
            { value0: entry.name }
          )}
        />
      ) : null}
      {help ? (
        <p
          className={
            entry.phase === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
          }
        >
          {help}
        </p>
      ) : null}
    </div>
  )
}

export function RemoteServerUpdateDialog(): React.JSX.Element {
  const open = useAppStore((state) => state.remoteServerUpdateDialogOpen)
  const setOpen = useAppStore((state) => state.setRemoteServerUpdateDialogOpen)
  const entryMap = useAppStore((state) => state.remoteServerUpdates)
  const entries = [...entryMap.values()]
  const checking = useAppStore((state) => state.remoteServerUpdatesChecking)
  const running = useAppStore((state) => state.remoteServerUpdatesRunning)
  const refresh = useAppStore((state) => state.refreshRemoteServerUpdates)
  const start = useAppStore((state) => state.startRemoteServerUpdates)
  const eligible = entries.filter(
    (entry) => entry.phase === 'available' || entry.phase === 'failed'
  )
  const allCurrent =
    entries.length > 0 &&
    !checking &&
    !running &&
    entries.every((entry) => entry.phase === 'current' || entry.phase === 'updated')
  const liveTabCount = eligible.reduce((total, entry) => total + entry.liveTabCount, 0)
  const liveLeafCount = eligible.reduce((total, entry) => total + entry.liveLeafCount, 0)
  const liveTabLabel =
    liveTabCount === 1
      ? translate('auto.components.settings.RemoteServerUpdateDialog.liveTabOne', '1 live tab')
      : translate(
          'auto.components.settings.RemoteServerUpdateDialog.liveTabs',
          '{{value0}} live tabs',
          { value0: liveTabCount }
        )
  const liveLeafLabel =
    liveLeafCount === 1
      ? translate('auto.components.settings.RemoteServerUpdateDialog.livePaneOne', '1 live pane')
      : translate(
          'auto.components.settings.RemoteServerUpdateDialog.livePanes',
          '{{value0}} live panes',
          { value0: liveLeafCount }
        )

  useEffect(() => {
    if (open) {
      void refresh()
    }
  }, [open, refresh])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.RemoteServerUpdateDialog.title',
              'Update Remote Orca Servers'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.RemoteServerUpdateDialog.description',
              'Review paired servers and update supported installs from this Orca client.'
            )}
          </DialogDescription>
        </DialogHeader>

        {eligible.length > 0 && (liveTabCount > 0 || liveLeafCount > 0) ? (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              {translate(
                'auto.components.settings.RemoteServerUpdateDialog.restartWarning',
                'Updating restarts these servers. {{value0}} and {{value1}} may briefly disconnect.',
                { value0: liveTabLabel, value1: liveLeafLabel }
              )}
            </p>
          </div>
        ) : null}

        <div className="scrollbar-sleek min-h-0 overflow-y-auto rounded-lg border border-border/50 bg-card/30">
          {entries.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {checking ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {translate(
                    'auto.components.settings.RemoteServerUpdateDialog.checking',
                    'Checking paired servers…'
                  )}
                </span>
              ) : (
                translate(
                  'auto.components.settings.RemoteServerUpdateDialog.empty',
                  'No paired Remote Orca Servers.'
                )
              )}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {entries.map((entry) => (
                <ServerUpdateRow
                  key={entry.environmentId}
                  entry={entry}
                  disabled={running || checking}
                  onUpdate={() => void start([entry.environmentId])}
                />
              ))}
            </div>
          )}
        </div>

        {checking ? (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {translate(
              'auto.components.settings.RemoteServerUpdateDialog.checking',
              'Checking paired servers…'
            )}
          </div>
        ) : allCurrent ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RemoteServerUpdateDialog.noUpdates',
              'All servers are up to date.'
            )}
          </p>
        ) : null}

        {eligible.length > 1 ? (
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              autoFocus={eligible.length > 0}
              onClick={() => void start()}
              disabled={checking || running}
            >
              {translate(
                'auto.components.settings.RemoteServerUpdateDialog.updateAll',
                'Update all {{value0}} servers',
                { value0: eligible.length }
              )}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export default RemoteServerUpdateDialog
