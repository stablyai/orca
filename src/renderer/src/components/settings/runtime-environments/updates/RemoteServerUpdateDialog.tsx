import type React from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { useAppStore } from '@/store/index'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import type { RemoteServerUpdateCheck } from '@/store/slices/runtime-host-updates/remote-server-updates'
import { useTranslate } from '@/i18n/use-translate'
import { RemoteServerUpdateStatus } from './RemoteServerUpdateStatus'
import {
  getRemoteServerEntryHelp as entryHelp,
  getRemoteServerVersionDescription as versionDescription
} from './remote-server-update-entry-copy'

function ServerUpdateRow({
  entry,
  disabled,
  onUpdate
}: {
  entry: RemoteServerUpdateEntry
  disabled: boolean
  onUpdate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const canUpdate = entry.phase === 'available' || entry.phase === 'failed'
  const help = entryHelp(entry, t)
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{entry.name}</span>
            <RemoteServerUpdateStatus entry={entry} compact />
          </div>
          <p className="text-xs text-muted-foreground">{versionDescription(entry, t)}</p>
        </div>
        {canUpdate ? (
          <Button type="button" variant="outline" size="xs" onClick={onUpdate} disabled={disabled}>
            {entry.phase === 'failed'
              ? t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')
              : t('auto.components.settings.RemoteServerUpdateDialog.update', 'Update server')}
          </Button>
        ) : null}
      </div>
      {entry.phase === 'downloading' && entry.progress !== null ? (
        <Progress
          value={entry.progress}
          aria-label={t(
            'auto.components.settings.RemoteServerUpdateDialog.downloadProgress',
            '{{value0}} download progress',
            { value0: entry.name }
          )}
        />
      ) : null}
      {help ? (
        <p
          className={
            entry.phase === 'failed'
              ? 'text-xs break-words text-destructive'
              : 'text-xs break-words text-muted-foreground'
          }
        >
          {help}
        </p>
      ) : null}
    </div>
  )
}

export function RemoteServerUpdateDialog(): React.JSX.Element {
  const t = useTranslate()
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
      ? t('auto.components.settings.RemoteServerUpdateDialog.liveTabOne', '1 live tab')
      : t('auto.components.settings.RemoteServerUpdateDialog.liveTabs', '{{value0}} live tabs', {
          value0: liveTabCount
        })
  const liveLeafLabel =
    liveLeafCount === 1
      ? t('auto.components.settings.RemoteServerUpdateDialog.livePaneOne', '1 live pane')
      : t('auto.components.settings.RemoteServerUpdateDialog.livePanes', '{{value0}} live panes', {
          value0: liveLeafCount
        })

  // Updates act only on targets and live-session counts this dialog checked itself: it owns the
  // check its own refresh returned, for the current revision. A refresh skipped because another
  // check or update was running is retried once that work ends; a failed one waits for Retry.
  const revision = useAppStore((state) => state.remoteServerUpdatesCheckRevision)
  const [ownedCheck, setOwnedCheck] = useState<RemoteServerUpdateCheck | null>(null)
  const [refreshFailed, setRefreshFailed] = useState(false)
  if (!open && (ownedCheck !== null || refreshFailed)) {
    // Each opening checks afresh.
    setOwnedCheck(null)
    setRefreshFailed(false)
  }
  const currentCheck = ownedCheck?.revision === revision ? ownedCheck : null
  // Bumped on every open and close, so a result from an earlier opening is ignored.
  const opening = useRef(0)
  useEffect(() => {
    opening.current += 1
  }, [open])
  const runRefresh = useCallback((): void => {
    const startedIn = opening.current
    setRefreshFailed(false)
    void refresh().then(
      (check) => {
        if (check && startedIn === opening.current) {
          setOwnedCheck(check)
        }
      },
      () => {
        if (startedIn === opening.current) {
          setRefreshFailed(true)
        }
      }
    )
  }, [refresh])
  const needsCheck = open && currentCheck === null && !refreshFailed && !checking && !running
  useEffect(() => {
    if (needsCheck) {
      runRefresh()
    }
  }, [needsCheck, runRefresh])
  const updatesBlocked = currentCheck === null || checking || running

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t(
              'auto.components.settings.RemoteServerUpdateDialog.dca6780b3a',
              'Update remote Orca servers'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.RemoteServerUpdateDialog.description',
              'Review paired servers and update supported installs from this Orca client.'
            )}
          </DialogDescription>
        </DialogHeader>

        {eligible.length > 0 && (liveTabCount > 0 || liveLeafCount > 0) ? (
          <div className="flex gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              {t(
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
                  {t(
                    'auto.components.settings.RemoteServerUpdateDialog.checking',
                    'Checking paired servers…'
                  )}
                </span>
              ) : refreshFailed ? null : (
                // A failed check says nothing about pairing; its error line below says what happened.
                t(
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
                  disabled={updatesBlocked}
                  onUpdate={() => {
                    if (currentCheck) {
                      void start([entry.environmentId], currentCheck)
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {checking ? (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t(
              'auto.components.settings.RemoteServerUpdateDialog.checking',
              'Checking paired servers…'
            )}
          </div>
        ) : refreshFailed ? (
          <p className="text-xs text-destructive">
            {t(
              'auto.components.settings.RemoteServerUpdateDialog.refreshFailed',
              'Could not check paired servers.'
            )}{' '}
            <Button
              type="button"
              variant="link"
              size="inlineInherit"
              disabled={running}
              onClick={runRefresh}
            >
              {t('auto.components.settings.RemoteServerUpdateDialog.retry', 'Retry')}
            </Button>
          </p>
        ) : allCurrent ? (
          <p className="text-xs text-muted-foreground">
            {t(
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
              onClick={() => {
                if (currentCheck) {
                  void start(undefined, currentCheck)
                }
              }}
              disabled={updatesBlocked}
            >
              {t(
                'auto.components.settings.RemoteServerUpdateDialog.updateAll',
                'Update all ({{value0}})',
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
