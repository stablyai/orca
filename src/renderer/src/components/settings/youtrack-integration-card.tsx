import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, ShieldOff, Unlink } from 'lucide-react'
import { YouTrackIcon } from '@/components/icons/YouTrackIcon'
import { Button } from '@/components/ui/button'
import { YouTrackConnectDialog } from '@/components/youtrack/YouTrackConnectDialog'
import { useYouTrackStore } from '@/components/youtrack/youtrack-store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { YOUTRACK_INTEGRATION_SECTION_ID } from './task-provider-integration-section-ids'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'

type VerificationResult = { state: 'ok' } | { state: 'error'; error: string }

export function YouTrackIntegrationCard(): React.JSX.Element {
  const status = useYouTrackStore((s) => s.status)
  const statusChecked = useYouTrackStore((s) => s.statusChecked)
  const checkStatus = useYouTrackStore((s) => s.checkStatus)
  const disconnect = useYouTrackStore((s) => s.disconnect)
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<VerificationResult | null>(null)

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  const connected = status.connected
  const checking = !statusChecked

  // Why: explicit user action only; status reads never decrypt the stored token.
  const handleTest = async (): Promise<void> => {
    const api = window.api?.youtrack
    if (!api) {
      return
    }
    setTesting(true)
    setTestResult(null)
    const result = await api.testConnection().catch((reason: unknown) => ({
      ok: false as const,
      error: reason instanceof Error ? reason.message : String(reason)
    }))
    if (!mountedRef.current) {
      return
    }
    setTesting(false)
    setTestResult(result.ok ? { state: 'ok' } : { state: 'error', error: result.error })
  }

  return (
    <IntegrationCardShell
      settingsSectionId={YOUTRACK_INTEGRATION_SECTION_ID}
      icon={<YouTrackIcon className="size-5" />}
      name="YouTrack"
      description={
        connected
          ? translate('youtrack.integration.connectedAs', 'Connected as {{name}}', {
              name: status.viewer?.fullName ?? status.viewer?.login ?? ''
            })
          : checking
            ? translate('youtrack.integration.checking', 'Checking YouTrack access.')
            : translate(
                'youtrack.integration.notConnected',
                'Add a self-hosted YouTrack to browse, update, and create issues.'
              )
      }
      checking={checking}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={
        connected
          ? translate('youtrack.integration.statusConnected', 'Connected')
          : translate('youtrack.integration.statusNotConnected', 'Not connected')
      }
      actions={
        checking ? null : (
          <Button
            variant={connected ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connected
              ? translate('youtrack.integration.reconnect', 'Reconnect')
              : translate('youtrack.integration.add', 'Add YouTrack access')}
          </Button>
        )
      }
    >
      <IntegrationCardDetails>
        <UnsealedCredentialNotice
          protection={status.credentialProtection ?? null}
          credentialName={translate('youtrack.integration.tokenName', 'Your YouTrack token')}
        />
        {connected ? (
          <div className="space-y-2">
            <div className={subordinateRowClass}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{status.baseUrl}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {status.viewer?.login}
                  {status.viewer?.email ? ` · ${status.viewer.email}` : ''}
                </p>
              </div>
              {testResult?.state === 'ok' ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                  <CheckCircle2 className="size-3.5" />
                  {translate('youtrack.integration.verified', 'Verified')}
                </span>
              ) : null}
              {testResult?.state === 'error' ? (
                <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span className="truncate" title={testResult.error}>
                    {testResult.error}
                  </span>
                </span>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTest()}
                disabled={testing}
              >
                {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {testing
                  ? translate('youtrack.integration.testing', 'Testing...')
                  : translate('youtrack.integration.test', 'Test')}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setTestResult(null)
                  void disconnect()
                }}
                aria-label={translate('youtrack.integration.disconnect', 'Disconnect YouTrack')}
                className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
              >
                <Unlink className="size-3.5" />
              </button>
            </div>
            {status.allowInsecureTls ? (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ShieldOff className="size-3.5 shrink-0" />
                {translate(
                  'youtrack.integration.insecureTls',
                  'Certificate verification is skipped for this host. Reconnect to turn it back on.'
                )}
              </p>
            ) : null}
          </div>
        ) : checking ? null : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'youtrack.integration.howTo',
              'Use your YouTrack address and a permanent token from Profile → Account Security.'
            )}
          </p>
        )}
      </IntegrationCardDetails>
      <YouTrackConnectDialog
        aboveSettings
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={() => setTestResult(null)}
      />
    </IntegrationCardShell>
  )
}
