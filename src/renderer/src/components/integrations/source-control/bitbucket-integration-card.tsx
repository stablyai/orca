import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, GitPullRequestArrow, LoaderCircle, Unlink } from 'lucide-react'
import type { BitbucketConnectionStatus } from '../../../../../shared/bitbucket/bitbucket-credentials'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import { useIntegrationSubordinateRowClass } from '../presentation/integration-card-presentation'
import type { BitbucketStatus } from './integrations-pane-status'
import { usePreflightCardStatuses } from './source-control-preflight-card-status'
import { tokenProviderStatusLabel } from './token-source-control-status'
import { BitbucketCredentialsDialog } from './bitbucket-credentials-dialog'
import { hasRemoteProviderRuntime } from '@/runtime/hosts/observations/provider-runtime-context'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'

const API_TOKEN_DOCS_URL = 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'
const DEFAULT_API_BASE_URL = 'https://api.bitbucket.org/2.0'

export function BitbucketIntegrationCard(): React.JSX.Element {
  const t = useTranslate()
  const settings = useAppStore((s) => s.settings)
  const remoteRuntime = hasRemoteProviderRuntime(settings)
  const readConnectionStatus = useAppStore((s) => s.readBitbucketConnectionStatus)
  const disconnectStoredCredential = useAppStore((s) => s.disconnectBitbucket)
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('bitbucket')
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const [connection, setConnection] = useState<BitbucketConnectionStatus | null>(null)
  const [connectionSettings, setConnectionSettings] = useState<GlobalSettings | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const [connectionFailedSettings, setConnectionFailedSettings] = useState<GlobalSettings | null>(
    null
  )
  const connectionLoadGenerationRef = useRef(0)

  // Read metadata only; mounting must not decrypt secrets or trigger keychain prompts.
  const loadConnection = useCallback(async () => {
    const generation = ++connectionLoadGenerationRef.current
    try {
      const next = await readConnectionStatus()
      // A host switch starts a new read; only the response for the current settings may paint.
      if (
        mountedRef.current &&
        generation === connectionLoadGenerationRef.current &&
        useAppStore.getState().settings === settings
      ) {
        setConnection(next)
        setConnectionSettings(settings)
        setConnectionFailedSettings(null)
      }
    } catch {
      // Report unreadable state as unknown rather than indistinguishable from missing credentials.
      if (
        mountedRef.current &&
        generation === connectionLoadGenerationRef.current &&
        useAppStore.getState().settings === settings
      ) {
        setConnectionSettings(settings)
        setConnectionFailedSettings(settings)
      }
    }
  }, [mountedRef, readConnectionStatus, settings])

  useEffect(() => {
    void loadConnection()
  }, [loadConnection])

  // A dialog opened under one host must not submit its form under another.
  useEffect(() => {
    setDialogOpen(false)
  }, [settings])

  // Reads and failures scoped to another host describe nobody actionable; keep actions down until a
  // read for this host lands, so Disconnect can never delete the active host's credential.
  const connectionIsCurrent = connectionSettings === settings
  const readFailed = connectionFailedSettings === settings
  const currentConnection = readFailed || !connectionIsCurrent ? null : connection
  const credentialStatusKnown = currentConnection !== null
  // A remote provider runtime owns the credential; the local preflight cannot see it.
  const remoteCardStatus: BitbucketStatus | 'unavailable' = readFailed
    ? 'unavailable'
    : currentConnection === null
      ? 'checking'
      : currentConnection.configured
        ? 'connected'
        : 'not-configured'
  const status: BitbucketStatus | 'unavailable' = remoteRuntime
    ? remoteCardStatus
    : unavailable
      ? 'unavailable'
      : statuses.bitbucketStatus
  const connected = status === 'connected'
  const envManaged = currentConnection?.source === 'environment'
  const storedCredential = currentConnection?.source === 'stored'
  const account = currentConnection?.account ?? statuses.bitbucketAccount
  // Only surface a base URL the user actually overrode; the default is noise.
  const baseUrlOverride =
    currentConnection?.baseUrl && currentConnection.baseUrl !== DEFAULT_API_BASE_URL
      ? currentConnection.baseUrl
      : null
  const authModeLabel = currentConnection?.authMode
    ? currentConnection.authMode === 'token'
      ? t('auto.components.settings.bitbucket.integration.card.authModeToken', 'Access token')
      : t('auto.components.settings.bitbucket.integration.card.authModeBasic', 'Email & API token')
    : null
  const credentialSummary = [authModeLabel, baseUrlOverride].filter(Boolean).join(' · ')

  const reloadCardState = (): void => {
    // A completion begun under a previous host must not start or invalidate this host's loads.
    if (useAppStore.getState().settings !== settings) {
      return
    }
    void loadConnection()
    refresh()
  }

  const handleDisconnect = async (): Promise<void> => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await disconnectStoredCredential()
    } catch (error) {
      // Surface deletion failures; otherwise disconnect silently repaints as still connected.
      if (mountedRef.current) {
        setDisconnectError(
          readIpcErrorMessage(error) ??
            t(
              'auto.components.settings.bitbucket.integration.card.disconnectFailed',
              'Could not remove the saved Bitbucket credential.'
            )
        )
      }
    } finally {
      if (mountedRef.current) {
        setDisconnecting(false)
      }
      reloadCardState()
    }
  }

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name="Bitbucket"
      description={
        connected
          ? account
            ? t(
                'auto.components.settings.token.source.control.integration.cards.ea204f5e03',
                '{{value0}} · Pull requests and build statuses',
                { value0: account }
              )
            : t(
                'auto.components.settings.token.source.control.integration.cards.0fa5629dad',
                'Pull requests and build statuses'
              )
          : t(
              'auto.components.settings.bitbucket.integration.card.description',
              'Pull requests and build statuses for Bitbucket Cloud.'
            )
      }
      checking={status === 'checking'}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={tokenProviderStatusLabel({ configured: connected, status }, t)}
      actions={
        status !== 'checking' && !envManaged && (credentialStatusKnown || readFailed) ? (
          <Button
            variant={storedCredential ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {readFailed
              ? t(
                  'auto.components.settings.bitbucket.integration.card.replaceCredentials',
                  'Manage credentials'
                )
              : storedCredential
                ? t('auto.components.settings.bitbucket.integration.card.edit', 'Edit credentials')
                : t('auto.components.settings.bitbucket.integration.card.connect', 'Connect')}
          </Button>
        ) : null
      }
    >
      {status !== 'checking' ? (
        <IntegrationCardDetails>
          <UnsealedCredentialNotice
            protection={connection?.credentialProtection ?? null}
            credentialName={t(
              'auto.components.settings.bitbucket.integration.card.credentialName',
              'Your Bitbucket credential'
            )}
          />
          {connected ? (
            <div className={subordinateRowClass}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {account ??
                    t(
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
                  aria-label={t(
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
          {readFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {t(
                'auto.components.settings.bitbucket.integration.card.statusLoadFailed',
                'Could not check for a saved Bitbucket credential.'
              )}
            </p>
          ) : null}
          {credentialStatusKnown ? (
            <BitbucketCardNote
              envManaged={envManaged}
              status={status}
              storedCredential={storedCredential}
              remoteRuntime={remoteRuntime}
            />
          ) : null}
          <div className="flex items-center gap-2">
            {!connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.api.shell.openUrl(API_TOKEN_DOCS_URL)}
              >
                <ExternalLink className="size-3.5 mr-1.5" />
                {t(
                  'auto.components.settings.token.source.control.integration.cards.1a9475dace',
                  'Learn more'
                )}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={reloadCardState}>
              {t(
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
        initialAuthMode={currentConnection?.authMode}
        initialEmail={currentConnection?.email}
        initialBaseUrl={currentConnection?.baseUrl}
        environmentManaged={envManaged}
        onConnected={reloadCardState}
      />
    </IntegrationCardShell>
  )
}

function BitbucketCardNote(props: {
  envManaged: boolean
  status: BitbucketStatus | 'unavailable'
  storedCredential: boolean
  remoteRuntime: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (props.status === 'unavailable') {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.token.source.control.integration.cards.24ac1c69dc',
          'Bitbucket status is not available in this runtime yet.'
        )}
      </p>
    )
  }
  if (props.envManaged) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
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
          ? t(
              'auto.components.settings.bitbucket.integration.card.storedAuthFailed',
              'The saved Bitbucket credential could not authenticate. Edit it, or check that the token still has pull request access.'
            )
          : t(
              'auto.components.settings.token.source.control.integration.cards.6154b02093',
              'Bitbucket credentials are configured but could not authenticate. Check the token and repository permissions, then restart Orca if environment variables changed.'
            )}
      </p>
    )
  }
  if (props.storedCredential) {
    return (
      <p className="text-xs text-muted-foreground">
        {props.remoteRuntime
          ? t(
              'auto.components.settings.bitbucket.integration.card.storedCredentialRemote',
              'Saved on the selected remote runtime. ORCA_BITBUCKET_* environment variables on that host take precedence when set.'
            )
          : t(
              'auto.components.settings.bitbucket.integration.card.storedCredential',
              'Saved in Orca on this machine. ORCA_BITBUCKET_* environment variables take precedence when set.'
            )}
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      {props.remoteRuntime
        ? t(
            'auto.components.settings.bitbucket.integration.card.notConfiguredRemote',
            'Connect a Bitbucket Cloud account with an Atlassian API token or an access token. ORCA_BITBUCKET_* environment variables on that host work too and take precedence.'
          )
        : t(
            'auto.components.settings.bitbucket.integration.card.notConfigured',
            'Connect a Bitbucket Cloud account with an Atlassian API token or an access token. ORCA_BITBUCKET_* environment variables work too and take precedence.'
          )}
    </p>
  )
}
