import { UnsealedCredentialNotice } from '../../provider-accounts/UnsealedCredentialNotice'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, GitPullRequestArrow, LoaderCircle, Unlink } from 'lucide-react'
import type { BitbucketConnectionStatus } from '../../../../../shared/bitbucket/bitbucket-credentials'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import { useIntegrationSubordinateRowClass } from '../presentation/integration-card-presentation'
import {
  usePreflightCardStatuses,
  type PreflightCardStatuses
} from './source-control-preflight-card-status'
import { tokenProviderStatusLabel } from './token-source-control-status'
import { BitbucketCredentialsDialog } from './bitbucket-credentials-dialog'
import { BitbucketCardNote } from './bitbucket-card-note'
import { useTranslate } from '@/i18n/use-translate'
import {
  bitbucketCredentialStatus,
  bitbucketDisconnect,
  BitbucketCredentialsHostOutdatedError
} from '@/runtime/source-control/bitbucket/runtime-bitbucket-credentials-client'
import { useBitbucketHostScope } from './bitbucket-host-scope'
import { ProviderHostScopeControl } from '../../provider-accounts/ProviderHostScopeControl'

const API_TOKEN_DOCS_URL = 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'
const DEFAULT_API_BASE_URL = 'https://api.bitbucket.org/2.0'

export function BitbucketIntegrationCard(): React.JSX.Element {
  const card = usePreflightCardStatuses('bitbucket')
  const target = card.host?.target ?? null
  const hostKey = !target
    ? 'pending'
    : target.kind === 'environment'
      ? `environment:${target.environmentId}`
      : 'local'
  // Why keyed: switching hosts drops the other host's status and any half-typed secret.
  return <BitbucketHostIntegrationCard key={hostKey} card={card} />
}

function BitbucketHostIntegrationCard({
  card
}: {
  card: PreflightCardStatuses
}): React.JSX.Element {
  const t = useTranslate()
  // Why the preflight host: the badge comes from it, so saves and status reads must go there too.
  // Why only the target frozen: the key pins it, while the scope copy follows live focus changes.
  const [target] = useState(card.host?.target ?? null)
  const remoteHost = target?.kind === 'environment'
  const accountScope = useBitbucketHostScope(card.host)
  const { statuses, unavailable, refresh } = card
  const status = unavailable ? 'unavailable' : statuses.bitbucketStatus
  const connected = status === 'connected'
  const mountedRef = useMountedRef()
  const subordinateRowClass = useIntegrationSubordinateRowClass('flex items-center gap-3')
  const accountScopeRowClass = useIntegrationSubordinateRowClass('text-xs')
  const [connection, setConnection] = useState<BitbucketConnectionStatus | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const [connectionLoadError, setConnectionLoadError] = useState<string | null>(null)
  const connectionLoadFailed = connectionLoadError !== null
  const connectionLoadGenerationRef = useRef(0)

  // Read metadata only; mounting must not decrypt secrets or trigger keychain prompts.
  const loadConnection = useCallback(async () => {
    const generation = ++connectionLoadGenerationRef.current
    if (!target) {
      return
    }
    try {
      const next = await bitbucketCredentialStatus(target)
      if (mountedRef.current && generation === connectionLoadGenerationRef.current) {
        setConnection(next)
        setConnectionLoadError(null)
      }
    } catch (error) {
      // Report unreadable state as unknown rather than indistinguishable from missing credentials.
      if (mountedRef.current && generation === connectionLoadGenerationRef.current) {
        setConnectionLoadError(
          error instanceof BitbucketCredentialsHostOutdatedError
            ? error.message
            : t(
                'auto.components.settings.bitbucket.integration.card.statusLoadFailed',
                'Could not check for a saved Bitbucket credential.'
              )
        )
      }
    }
  }, [mountedRef, target, t])

  useEffect(() => {
    void loadConnection()
  }, [loadConnection])

  const currentConnection = connectionLoadFailed ? null : connection
  const credentialStatusKnown = currentConnection !== null
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
    void loadConnection()
    refresh()
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!target) {
      return
    }
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      await bitbucketDisconnect(target)
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
        status !== 'checking' && !envManaged && (credentialStatusKnown || connectionLoadFailed) ? (
          <Button
            variant={storedCredential ? 'outline' : 'default'}
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            {connectionLoadFailed
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
          {target ? (
            <ProviderHostScopeControl
              labelPrefix={t(
                'auto.components.settings.bitbucket.integration.card.account_scope_prefix',
                'Account scope'
              )}
              scope={accountScope}
              className={accountScopeRowClass}
            />
          ) : null}
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
          {connectionLoadFailed ? (
            <p role="alert" className="text-xs text-destructive">
              {connectionLoadError}
            </p>
          ) : null}
          {credentialStatusKnown ? (
            <BitbucketCardNote
              envManaged={envManaged}
              status={status}
              storedCredential={storedCredential}
              remoteHost={remoteHost}
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

      {target ? (
        <BitbucketCredentialsDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          initialAuthMode={currentConnection?.authMode}
          initialEmail={currentConnection?.email}
          initialBaseUrl={currentConnection?.baseUrl}
          environmentManaged={envManaged}
          target={target}
          onConnected={reloadCardState}
        />
      ) : null}
    </IntegrationCardShell>
  )
}
