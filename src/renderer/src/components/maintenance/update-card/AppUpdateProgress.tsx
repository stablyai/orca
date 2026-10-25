import { hasReachedAppVersion } from '../../../../../shared/app-version'
import { useState, type ReactNode } from 'react'
import { AlertCircle, ChevronDown, Minus } from 'lucide-react'
import type { AppUpdateBatch, AppUpdateRemote } from '../../../../../shared/app-update-batch'
import { remoteUpdateNeedsAttention } from '../../../../../shared/app-update-batch'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { getRemoteServerUpdatePhaseLabel } from '@/components/settings/RemoteServerUpdateStatus'
import { translate } from '@/i18n/i18n'

export function appUpdateStageLabel(batch: AppUpdateBatch): string {
  if (batch.stage === 'recovery') {
    return translate('updates.reviewRemotes', 'Review remote updates')
  }
  if (batch.stage === 'attention') {
    const failed = batch.remotes.filter((remote) => remote.phase === 'failed').length
    if (failed) {
      return failed === 1
        ? translate('updates.remoteFailedOne', '1 remote failed')
        : translate('updates.remoteFailedCount', '{{count}} remotes failed', { count: failed })
    }
    if (batch.remotes.some(remoteUpdateNeedsAttention)) {
      return translate('updates.remoteNotConfirmed', 'Remote update not confirmed')
    }
    return translate('updates.appNeedsAttention', 'App update needs attention')
  }
  if (batch.stage === 'installing') {
    return translate('updates.restartingApp', 'Restarting this app…')
  }
  if (batch.stage === 'preparing') {
    return translate('updates.preparingDownloads', 'Preparing downloads…')
  }
  return translate('updates.updatingRemotes', 'Updating remotes…')
}

function remoteLabel(remote: AppUpdateRemote): string {
  if (remote.phase === 'restarting') {
    return translate('updates.remoteReconnecting', 'Reconnecting…')
  }
  const label = getRemoteServerUpdatePhaseLabel(remote.phase)
  return remote.phase === 'downloading' && remote.progress !== null
    ? `${label} ${Math.round(remote.progress)}%`
    : label
}

export function AppUpdateProgress({
  onCollapse,
  recoveryContent
}: {
  onCollapse: () => void
  recoveryContent?: ReactNode
}): React.JSX.Element | null {
  const batch = useAppStore((state) => state.appUpdateBatch)
  const running = useAppStore((state) => state.appUpdateRunning)
  const status = useAppStore((state) => state.updateStatus)
  const localVersion = useAppStore((state) => state.appUpdateLocalVersion)
  const retry = useAppStore((state) => state.retryAppUpdateRemote)
  const retryDownload = useAppStore((state) => state.retryAppUpdateDownload)
  const proceed = useAppStore((state) => state.continueAppUpdate)
  const dismiss = useAppStore((state) => state.dismissAppUpdateRecovery)
  const [open, setOpen] = useState(false)
  if (!batch) {
    return null
  }
  const issues = batch.remotes.filter(remoteUpdateNeedsAttention)
  const attention =
    !running &&
    (batch.stage === 'attention' || batch.stage === 'recovery' || status.state === 'error')
  const localUpdated =
    localVersion !== null && hasReachedAppVersion(localVersion, batch.targetVersion)
  const localReady = status.state === 'downloaded' && status.version === batch.targetVersion
  const localError = status.state === 'error' ? status.message : batch.error
  const localLabel = localUpdated
    ? translate('updates.thisAppUpdated', 'Updated')
    : status.state === 'downloading'
      ? translate('updates.thisAppDownloading', 'Downloading {{percent}}%', {
          percent: Math.round(status.percent)
        })
      : localReady
        ? translate('updates.thisAppReady', 'Ready to restart')
        : translate('updates.thisAppWaiting', 'Waiting')
  return (
    <div className="p-3.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {translate('updates.updatingOrca', 'Updating Orca')}
          </h3>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onCollapse}
            aria-label={translate('updates.minimize', 'Minimize update')}
          >
            <Minus className="size-3.5" />
          </Button>
        </div>
        <Progress
          indeterminate
          paused={attention}
          aria-label={translate('updates.activity', 'Update activity')}
          className="h-1"
        />
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {issues.length > 0 && <AlertCircle className="size-3 shrink-0 text-destructive" />}
          <span className="min-w-0 flex-1">{appUpdateStageLabel(batch)}</span>
          {running && issues.length > 0 && (
            <span>
              {translate('updates.issueCount', '{{count}} need attention', {
                count: issues.length
              })}
            </span>
          )}
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate('updates.showProgressDetails', 'Show update details')}
            >
              <ChevronDown
                className={`size-3.5 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent animation="height">
          <div className="mt-3 space-y-3 border-t pt-3 text-xs">
            {batch.remotes.map((remote) => (
              <div key={remote.environmentId} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">{remote.name}</span>
                  <span
                    className={
                      remoteUpdateNeedsAttention(remote)
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {remoteLabel(remote)}
                  </span>
                </div>
                {attention && remote.error && (
                  <p className="break-words text-muted-foreground">{remote.error}</p>
                )}
                {attention && remoteUpdateNeedsAttention(remote) && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={running}
                    onClick={() => void retry(remote.environmentId)}
                  >
                    {remote.phase === 'failed'
                      ? translate('updates.retryRemote', 'Retry remote')
                      : translate('updates.checkRemoteAgain', 'Check again')}
                  </Button>
                )}
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <span>{translate('updates.thisApp', 'This app')}</span>
              <span className="text-muted-foreground">{localLabel}</span>
            </div>
            {recoveryContent}
            {attention && localError && (
              <p className="break-words text-destructive">{localError}</p>
            )}
            {attention && issues.length > 0 && !localUpdated && (
              <p className="text-muted-foreground">
                {translate(
                  'updates.okayConsequence',
                  'Okay finishes the app update. These remotes stay flagged for review after restart.'
                )}
              </p>
            )}
            {attention && (
              <div className="flex justify-end gap-2">
                {!localUpdated && !localReady && (
                  <Button size="xs" variant="outline" onClick={() => void retryDownload()}>
                    {translate('updates.retryAppDownload', 'Retry app download')}
                  </Button>
                )}
                {localReady && (
                  <Button size="xs" onClick={() => void proceed()}>
                    {translate('updates.okay', 'Okay')}
                  </Button>
                )}
                {localUpdated && (
                  <Button size="xs" onClick={() => void dismiss()}>
                    {translate('updates.okay', 'Okay')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
