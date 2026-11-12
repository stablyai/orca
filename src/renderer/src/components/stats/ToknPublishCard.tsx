import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, Unlink } from 'lucide-react'
import type { ToknSyncErrorCode, ToknSyncStatus } from '../../../../shared/tokn-sync-status'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { ToknIcon } from '../icons/ToknIcon'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../integrations/presentation/integration-card-shell'
import { ToknUploadPreview } from './ToknUploadPreview'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'

const STATUS_POLL_MS = 1500

// Tracking-off is shown as a live hint with its own action instead of a stale error.
function syncErrorCopy(
  code: Exclude<ToknSyncErrorCode, 'tracking-off'>,
  detail: string | null,
  t: Translate
): string {
  switch (code) {
    case 'network':
      return t(
        'auto.components.stats.ToknPublishCard.errorNetwork',
        'Could not reach tokn. Orca tries again within the hour.'
      )
    case 'rate-limited':
      return t(
        'auto.components.stats.ToknPublishCard.errorRateLimited',
        'tokn asked Orca to wait. Orca tries again within the hour.'
      )
    case 'rejected':
      return t(
        'auto.components.stats.ToknPublishCard.errorRejected',
        'tokn did not accept the upload: {{detail}}',
        { detail: detail ?? '' }
      )
    case 'server':
      return t(
        'auto.components.stats.ToknPublishCard.errorServer',
        'tokn could not store the upload. Orca tries again within the hour.'
      )
    case 'signed-out':
      return t(
        'auto.components.stats.ToknPublishCard.errorSignedOut',
        'This computer was signed out of tokn. Connect again to keep publishing.'
      )
  }
}

// Module-level because React Compiler cannot compile try/finally without catch.
async function whileBusy(
  setBusy: (busy: boolean) => void,
  isMounted: () => boolean,
  work: () => Promise<void>
): Promise<void> {
  setBusy(true)
  try {
    await work()
  } finally {
    if (isMounted()) {
      setBusy(false)
    }
  }
}

export function ToknPublishCard(): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const mountedRef = useMountedRef()
  const setClaudeUsageEnabled = useAppStore((state) => state.setClaudeUsageEnabled)
  const setCodexUsageEnabled = useAppStore((state) => state.setCodexUsageEnabled)
  const [status, setStatus] = useState<ToknSyncStatus | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const applyStatus = useCallback(
    (next: ToknSyncStatus) => {
      if (mountedRef.current) {
        setStatus(next)
      }
    },
    [mountedRef]
  )

  const refreshStatus = useCallback(async () => {
    applyStatus(await window.api.tokn.getStatus())
  }, [applyStatus])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Depends on the status object, not its flags, so each poll schedules the next one.
  // Polls during sign-in too: a card mounted mid-sign-in never sees the connect() result.
  useEffect(() => {
    if (!status?.syncing && !status?.connecting) {
      return
    }
    const timer = setTimeout(() => void refreshStatus(), STATUS_POLL_MS)
    return () => clearTimeout(timer)
  }, [status, refreshStatus])

  const runAction = (action: () => Promise<ToknSyncStatus>): Promise<void> =>
    whileBusy(
      setBusy,
      () => mountedRef.current,
      async () => applyStatus(await action())
    )

  const handleConnect = async (): Promise<void> => {
    setConnectError(null)
    // Sign-in waits on the browser, so show the waiting state straight away.
    setStatus((current) => (current ? { ...current, connecting: true } : current))
    const result = await window.api.tokn.connect()
    applyStatus(result.status)
    if (!mountedRef.current) {
      return
    }
    if (result.outcome === 'timed-out') {
      setConnectError(
        t(
          'auto.components.stats.ToknPublishCard.connectTimedOut',
          'Sign-in timed out. Connect again to retry.'
        )
      )
    } else if (result.outcome === 'failed') {
      setConnectError(
        t(
          'auto.components.stats.ToknPublishCard.connectFailed',
          'Could not connect to tokn: {{error}}',
          { error: result.error ?? '' }
        )
      )
    }
  }

  const handleEnableTracking = async (): Promise<void> => {
    await Promise.all([setClaudeUsageEnabled(true), setCodexUsageEnabled(true)])
    await refreshStatus()
  }

  const connected = status?.connected ?? false
  const connecting = status?.connecting ?? false
  const syncing = status?.syncing ?? false
  const trackingOff = status !== null && !status.tracking.claude && !status.tracking.codex

  const description = connected
    ? t('auto.components.stats.ToknPublishCard.connectedAs', 'Connected as @{{handle}}', {
        handle: status?.handle ?? ''
      })
    : t(
        'auto.components.stats.ToknPublishCard.description',
        'Publish your daily Claude Code and Codex totals to a profile and leaderboard on toknhq.com.'
      )

  const actions = connecting ? (
    <>
      <Button variant="outline" size="sm" disabled>
        <Loader2 className="size-4 animate-spin" />
        {t('auto.components.stats.ToknPublishCard.waitingForBrowser', 'Waiting for browser')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void runAction(() => window.api.tokn.cancelConnect())}
      >
        {t('auto.components.stats.ToknPublishCard.cancel', 'Cancel')}
      </Button>
    </>
  ) : connected ? (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || syncing}
        onClick={() => void runAction(() => window.api.tokn.syncNow())}
      >
        {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        {t('auto.components.stats.ToknPublishCard.syncNow', 'Sync now')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void runAction(() => window.api.tokn.disconnect())}
      >
        <Unlink className="size-4" />
        {t('auto.components.stats.ToknPublishCard.disconnect', 'Disconnect')}
      </Button>
    </>
  ) : status ? (
    <Button size="sm" onClick={() => void handleConnect()}>
      {t('auto.components.stats.ToknPublishCard.connect', 'Connect tokn')}
    </Button>
  ) : null

  return (
    <IntegrationCardShell
      icon={<ToknIcon className="size-5" />}
      name="tokn"
      description={description}
      checking={status === null}
      statusTone={connected ? 'connected' : 'neutral'}
      statusLabel={
        connected
          ? t('auto.components.stats.ToknPublishCard.statusConnected', 'Connected')
          : t('auto.components.stats.ToknPublishCard.statusNotConnected', 'Not connected')
      }
      actions={actions}
    >
      <IntegrationCardDetails>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.stats.ToknPublishCard.privacy',
            'Uploads one total per day and model: requests, tokens, and estimated cost. Never prompts, code, file paths, or project names. Covers all Claude Code and Codex usage Orca tracks on this computer. tokn also stores the name of this computer to list it under your account.'
          )}
        </p>
        {connected && status ? (
          <p className="text-xs text-muted-foreground">
            {status.lastSyncAt
              ? t(
                  'auto.components.stats.ToknPublishCard.lastSynced',
                  'Last synced {{time}} · {{count}} rows stored',
                  {
                    time: new Date(status.lastSyncAt).toLocaleString(intlLocale),
                    count: status.lastSyncAccepted ?? 0,
                    defaultValue_one: 'Last synced {{time}} · {{count}} row stored'
                  }
                )
              : t('auto.components.stats.ToknPublishCard.notSyncedYet', 'Not synced yet')}
            {status.lastSyncRejected
              ? t(
                  'auto.components.stats.ToknPublishCard.rowsRejected',
                  ' · {{count}} rows not accepted',
                  {
                    count: status.lastSyncRejected,
                    defaultValue_one: ' · {{count}} row not accepted'
                  }
                )
              : ''}
          </p>
        ) : null}
        {status?.lastSyncError && status.lastSyncError !== 'tracking-off' ? (
          <p className="text-xs text-destructive" role="alert">
            {syncErrorCopy(status.lastSyncError, status.lastSyncErrorDetail, t)}
          </p>
        ) : null}
        {connectError ? (
          <p className="text-xs text-destructive" role="alert">
            {connectError}
          </p>
        ) : null}
        {trackingOff ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {t(
                'auto.components.stats.ToknPublishCard.trackingOff',
                'Claude and Codex usage tracking are off, so there is nothing to publish yet.'
              )}
            </p>
            <Button variant="outline" size="xs" onClick={() => void handleEnableTracking()}>
              {t('auto.components.stats.ToknPublishCard.enableTracking', 'Turn on tracking')}
            </Button>
          </div>
        ) : null}
        {connected && status?.profileUrl ? (
          <Button
            variant="link"
            size="inline"
            onClick={(event) => {
              if (status.profileUrl) {
                openAppHttpLink(status.profileUrl, { event })
              }
            }}
          >
            {t('auto.components.stats.ToknPublishCard.viewProfile', 'View profile')}
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
        <ToknUploadPreview />
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}
