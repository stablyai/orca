import { useCallback, useEffect, useRef, useState } from 'react'
import { GitPullRequestArrow, LoaderCircle } from 'lucide-react'
import type { BitbucketServerConnectionStatus } from '../../../../shared/bitbucket-server-credentials'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import { UnsealedCredentialNotice } from './UnsealedCredentialNotice'
import { BitbucketServerCredentialsDialog } from './bitbucket-server-credentials-dialog'

export function BitbucketServerIntegrationCard(): React.JSX.Element {
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const [connection, setConnection] = useState<BitbucketServerConnectionStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const generationRef = useRef(0)

  // Plaintext metadata only, so opening Settings never prompts for the keychain.
  const loadConnection = useCallback(async () => {
    const generation = ++generationRef.current
    try {
      const next = await window.api.bitbucketServer.status()
      if (mountedRef.current && generation === generationRef.current) {
        setConnection(next)
        setLoadFailed(false)
      }
    } catch {
      if (mountedRef.current && generation === generationRef.current) {
        setLoadFailed(true)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void loadConnection()
  }, [loadConnection])

  const current = loadFailed ? null : connection
  const configured = current?.configured === true
  const envManaged = current?.source === 'environment'
  const stored = current?.source === 'stored'

  const handleDisconnect = async (): Promise<void> => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await window.api.bitbucketServer.disconnect()
    } catch (error) {
      if (mountedRef.current) {
        setDisconnectError(
          readIpcErrorMessage(error) ??
            translate(
              'auto.components.settings.bitbucket.server.integration.card.disconnectFailed',
              'Could not remove the saved Bitbucket Server credential.'
            )
        )
      }
    } finally {
      if (mountedRef.current) {
        setDisconnecting(false)
      }
      void loadConnection()
    }
  }

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name={translate(
        'auto.components.settings.bitbucket.server.integration.card.name',
        'Bitbucket Data Center'
      )}
      description={translate(
        'auto.components.settings.bitbucket.server.integration.card.description',
        'Pull requests and build statuses for Bitbucket Data Center and Server.'
      )}
      checking={current === null && !loadFailed}
      statusTone={configured ? 'connected' : 'attention'}
      statusLabel={
        configured
          ? translate(
              'auto.components.settings.token.source.control.integration.cards.statusConnected',
              'Connected'
            )
          : translate(
              'auto.components.settings.token.source.control.integration.cards.statusNotConfigured',
              'Not configured'
            )
      }
      actions={
        !envManaged && (current !== null || loadFailed) ? (
          <Button
            variant={stored ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {stored
              ? translate(
                  'auto.components.settings.bitbucket.server.integration.card.edit',
                  'Edit credentials'
                )
              : translate(
                  'auto.components.settings.bitbucket.server.integration.card.connect',
                  'Connect'
                )}
          </Button>
        ) : null
      }
    >
      <IntegrationCardDetails>
        <UnsealedCredentialNotice
          protection={current?.credentialProtection ?? null}
          credentialName={translate(
            'auto.components.settings.bitbucket.server.integration.card.credentialName',
            'Your Bitbucket Server token'
          )}
        />
        {configured ? (
          <div className={subordinateRowClass}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {current?.account ??
                  translate(
                    'auto.components.settings.bitbucket.server.integration.card.accountUnknown',
                    'Bitbucket Data Center'
                  )}
              </p>
              {current?.baseUrl ? (
                <p className="truncate text-xs text-muted-foreground">{current.baseUrl}</p>
              ) : null}
            </div>
            {stored ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleDisconnect()}
                disabled={disconnecting}
              >
                {disconnecting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {translate(
                  'auto.components.settings.bitbucket.server.integration.card.disconnect',
                  'Disconnect'
                )}
              </Button>
            ) : null}
          </div>
        ) : null}
        {disconnectError ? <p className="text-xs text-destructive">{disconnectError}</p> : null}
        {loadFailed ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'auto.components.settings.bitbucket.server.integration.card.statusLoadFailed',
              'Could not check for a saved Bitbucket Server credential.'
            )}
          </p>
        ) : null}
        {envManaged ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.bitbucket.server.integration.card.envManaged',
              'Configured via ORCA_BITBUCKET_SERVER_BASE_URL and ORCA_BITBUCKET_SERVER_TOKEN. Unset them to manage this credential in Orca.'
            )}
          </p>
        ) : null}
      </IntegrationCardDetails>

      <BitbucketServerCredentialsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialBaseUrl={current?.baseUrl}
        onConnected={() => void loadConnection()}
      />
    </IntegrationCardShell>
  )
}
