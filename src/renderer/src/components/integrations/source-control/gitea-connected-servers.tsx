import { useState } from 'react'
import { AlertCircle, CheckCircle2, LoaderCircle, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'

type VerificationResult = { state: 'ok' | 'error'; error?: string }

/** Gitea servers saved in Settings, each with Test and Disconnect. */
export function GiteaConnectedServers({
  onChanged
}: {
  onChanged: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const giteaStatus = useAppStore((s) => s.giteaStatus)
  const giteaDisconnect = useAppStore((s) => s.giteaDisconnect)
  const giteaTestConnection = useAppStore((s) => s.giteaTestConnection)
  const mountedRef = useMountedRef()
  const [testingServerId, setTestingServerId] = useState<string | null>(null)
  const [testResultByServer, setTestResultByServer] = useState<Record<string, VerificationResult>>(
    {}
  )
  const servers = giteaStatus?.servers ?? []

  const handleDisconnect = async (serverId: string): Promise<void> => {
    // A failed disconnect stays listed and says why; a successful one clears stale results.
    const failure = await giteaDisconnect(serverId).then(
      () => null,
      (error: unknown) =>
        error instanceof Error
          ? error.message
          : t(
              'auto.components.settings.gitea.disconnectFailed',
              'Could not disconnect this server.'
            )
    )
    onChanged()
    if (mountedRef.current) {
      setTestResultByServer(failure ? { [serverId]: { state: 'error', error: failure } } : {})
    }
  }

  const handleTest = async (serverId: string): Promise<void> => {
    setTestingServerId(serverId)
    setTestResultByServer((prev) => withoutServer(prev, serverId))
    const result = await testServer(
      () => giteaTestConnection(serverId),
      t('auto.components.settings.gitea.integration.card.d4e5f6a7b8', 'Connection failed.')
    )
    if (mountedRef.current) {
      setTestResultByServer((prev) => ({ ...prev, [serverId]: result }))
      setTestingServerId(null)
    }
  }

  if (servers.length === 0 && !giteaStatus?.credentialError) {
    return null
  }
  return (
    <div className="mt-3 space-y-2">
      {giteaStatus?.credentialError ? (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5 shrink-0" />
          {giteaStatus.credentialError}
        </p>
      ) : null}
      {servers.map((server) => {
        const testResult = testResultByServer[server.id]
        const testing = testingServerId === server.id
        return (
          <div
            key={server.id}
            className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{server.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {server.baseUrl}
                {server.account ? ` · ${server.account}` : ''}
              </p>
            </div>
            {testResult?.state === 'ok' ? (
              <span className="flex shrink-0 items-center gap-1 text-xs text-status-success">
                <CheckCircle2 className="size-3.5" />
                {t('auto.components.settings.gitea.integration.card.3852b1fd6f', 'Verified')}
              </span>
            ) : null}
            {testResult?.state === 'error' ? (
              <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span className="truncate">{testResult.error}</span>
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleTest(server.id)}
              disabled={testing}
            >
              {testing ? (
                <>
                  <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                  {t('auto.components.settings.gitea.integration.card.09bde44485', 'Testing...')}
                </>
              ) : (
                t('auto.components.settings.gitea.integration.card.2bf28d5929', 'Test')
              )}
            </Button>
            <button
              type="button"
              onClick={() => void handleDisconnect(server.id)}
              aria-label={t(
                'auto.components.settings.gitea.integration.card.d0b31b4845',
                'Disconnect {{value0}}',
                { value0: server.displayName }
              )}
              className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
            >
              <Unlink className="size-3.5" />
            </button>
          </div>
        )
      })}
      {servers.length > 0 ? (
        <p className="text-[11px] text-muted-foreground/70">
          {t(
            'auto.components.settings.gitea.integration.card.f47924e554',
            'Each server stores one token locally, encrypted when runtime storage supports it.'
          )}
        </p>
      ) : null}
    </div>
  )
}

async function testServer(
  run: () => Promise<{ ok: boolean; error?: string }>,
  fallbackError: string
): Promise<VerificationResult> {
  try {
    const result = await run()
    return result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
  } catch (error) {
    return { state: 'error', error: error instanceof Error ? error.message : fallbackError }
  }
}

function withoutServer(
  results: Record<string, VerificationResult>,
  serverId: string
): Record<string, VerificationResult> {
  const next = { ...results }
  delete next[serverId]
  return next
}
