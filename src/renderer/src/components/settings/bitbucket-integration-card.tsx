import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, GitPullRequestArrow, LoaderCircle, Unlink } from 'lucide-react'
import type { BitbucketConnectionStatus } from '../../../../shared/bitbucket-credentials'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { useIntegrationSubordinateRowClass } from './integration-card-presentation'
import type { BitbucketStatus } from './integrations-pane-status'
import { usePreflightCardStatuses } from './source-control-preflight-card-status'
import { tokenProviderStatusLabel } from './token-source-control-status'
import { BitbucketCredentialsDialog } from './bitbucket-credentials-dialog'
import { translate } from '@/i18n/i18n'

const API_TOKEN_DOCS_URL = 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'
const DEFAULT_API_BASE_URL = 'https://api.bitbucket.org/2.0'

export function BitbucketIntegrationCard(): React.JSX.Element {
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('bitbucket')
  const status = unavailable ? 'unavailable' : statuses.bitbucketStatus
  const connected = status === 'connected'
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const [connection, setConnection] = useState<BitbucketConnectionStatus | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  // Reads plaintext metadata only — never the encrypted secret — so mounting the
  // pane cannot trigger a keychain prompt.
  const loadConnection = useCallback(async () => {
    try {
      const next = await window.api.bitbucket.status()
      if (mountedRef.current) {
        setConnection(next)
      }
    } catch {
      // Best-effort: the preflight-driven parts of the card still render.
    }
  }, [mountedRef])

  useEffect(() => {
    void loadConnection()
  }, [loadConnection])

  const envManaged = connection?.source === 'environment'
  const storedCredential = connection?.source === 'stored'
  const account = connection?.account ?? statuses.bitbucketAccount
  // Only surface a base URL the user actually overrode; the default is noise.
  const baseUrlOverride =
    connection?.baseUrl && connection.baseUrl !== DEFAULT_API_BASE_URL ? connection.baseUrl : null
  const authModeLabel = connection?.authMode
    ? connection.authMode === 'token'
      ? translate(
          'auto.components.settings.bitbucket.integration.card.authModeToken',
          'Access token'
        )
      : translate(
          'auto.components.settings.bitbucket.integration.card.authModeBasic',
          'Email & API token'
        )
    : null
  const credentialSummary = [authModeLabel, baseUrlOverride].filter(Boolean).join(' · ')

  const handleConnected = (): void => {
    void loadConnection()
    refresh()
  }

  const handleDisconnect = async (): Promise<void> => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await window.api.bitbucket.disconnect()
    } catch (error) {
      // Why: disconnect rethrows when a credential file cannot be deleted.
      // Unhandled, the card silently re-renders as still connected.
      if (mountedRef.current) {
        setDisconnectError(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.bitbucket.integration.card.disconnectFailed',
                'Could not remove the saved Bitbucket credential.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setDisconnecting(false)
      }
      void loadConnection()
      refresh()
    }
  }

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name="Bitbucket"
      description={
        connected
          ? account
            ? translate(
                'auto.components.settings.token.source.control.integration.cards.ea204f5e03',
                '{{value0}} · Pull requests and build statuses',
                { value0: account }
              )
            : translate(
                'auto.components.settings.token.source.control.integration.cards.0fa5629dad',
                'Pull requests and build statuses'
              )
          : translate(
              'auto.components.settings.bitbucket.integration.card.description',
              'Pull requests and build statuses for Bitbucket Cloud.'
            )
      }
      checking={status === 'checking'}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={tokenProviderStatusLabel({ configured: connected, status })}
      actions={
        status !== 'checking' && !envManaged ? (
          <Button
            variant={storedCredential ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {storedCredential
              ? translate(
                  'auto.components.settings.bitbucket.integration.card.edit',
                  'Edit credentials'
                )
              : translate('auto.components.settings.bitbucket.integration.card.connect', 'Connect')}
          </Button>
        ) : null
      }
    >
      {status !== 'checking' ? (
        <IntegrationCardDetails>
          {connected ? (
            <div className={subordinateRowClass}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {account ??
                    translate(
                      'auto.components.settings.bitbucket.integration.card.accountUnknown',
                      'Bitbucket Cloud'
                    )}
                </p>
                {credentialSummary ? (
                  <p className="truncate text-xs text-muted-foreground">{credentialSummary}</p>
                ) : null}
              </div>
              {storedCredential ? (
                <button
                  onClick={() => void handleDisconnect()}
                  disabled={disconnecting}
                  aria-label={translate(
                    'auto.components.settings.bitbucket.integration.card.disconnect',
                    'Disconnect Bitbucket'
                  )}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                >
                  {disconnecting ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Unlink className="size-3.5" />
                  )}
                </button>
              ) : null}
            </div>
          ) : null}
          {disconnectError ? <p className="text-xs text-destructive">{disconnectError}</p> : null}
          <BitbucketCardNote
            envManaged={envManaged}
            status={status}
            storedCredential={storedCredential}
          />
          <div className="flex items-center gap-2">
            {!connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.api.shell.openUrl(API_TOKEN_DOCS_URL)}
              >
                <ExternalLink className="size-3.5 mr-1.5" />
                {translate(
                  'auto.components.settings.token.source.control.integration.cards.1a9475dace',
                  'Learn more'
                )}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={refresh}>
              {translate(
                'auto.components.settings.token.source.control.integration.cards.793a06e899',
                'Re-check'
              )}
            </Button>
          </div>
        </IntegrationCardDetails>
      ) : null}

      <BitbucketCredentialsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialAuthMode={connection?.authMode}
        initialEmail={connection?.email}
        initialBaseUrl={connection?.baseUrl}
        environmentManaged={envManaged}
        onConnected={handleConnected}
      />
    </IntegrationCardShell>
  )
}

function BitbucketCardNote(props: {
  envManaged: boolean
  status: BitbucketStatus | 'unavailable'
  storedCredential: boolean
}): React.JSX.Element {
  if (props.status === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.token.source.control.integration.cards.24ac1c69dc',
          'Bitbucket status is not available in this runtime yet.'
        )}
      </p>
    )
  }
  if (props.envManaged) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.bitbucket.integration.card.envManaged',
          'Configured via environment variables. Unset the ORCA_BITBUCKET_* variables to manage this credential in Orca.'
        )}
      </p>
    )
  }
  if (props.status === 'not-authenticated') {
    return (
      <p className="text-xs text-muted-foreground">
        {props.storedCredential
          ? translate(
              'auto.components.settings.bitbucket.integration.card.storedAuthFailed',
              'The saved Bitbucket credential could not authenticate. Edit it, or check that the token still has pull request access.'
            )
          : translate(
              'auto.components.settings.token.source.control.integration.cards.6154b02093',
              'Bitbucket credentials are configured but could not authenticate. Check the token and repository permissions, then restart Orca if environment variables changed.'
            )}
      </p>
    )
  }
  if (props.storedCredential) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.bitbucket.integration.card.storedCredential',
          'Saved in Orca on this machine. ORCA_BITBUCKET_* environment variables take precedence when set.'
        )}
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      {translate(
        'auto.components.settings.bitbucket.integration.card.notConfigured',
        'Connect a Bitbucket Cloud account with an Atlassian API token or an access token. ORCA_BITBUCKET_* environment variables work too and take precedence.'
      )}
    </p>
  )
}
