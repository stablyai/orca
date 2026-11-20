import { useId } from 'react'
import { ExternalLink, GitPullRequestArrow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SettingsRow } from '@/components/settings/form-controls/SettingsFormControls'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type {
  AzureDevOpsAuthErrorCode,
  AzureDevOpsAuthMethod
} from '../../../../../shared/source-control/azure-devops-auth-types'
import {
  IntegrationCardDetails,
  IntegrationCardShell
} from '../presentation/integration-card-shell'
import type { AzureDevOpsHostAuth } from './use-azure-devops-host-auth'

function cliRecovery(code: AzureDevOpsAuthErrorCode | undefined, t: Translate): string {
  switch (code) {
    case 'cli-not-installed':
      return t(
        'settings.azureDevOps.cliMissing',
        'On the credential host, install Azure CLI if needed and make sure az is on PATH. Run az login, then select Re-check.'
      )
    case 'login-required':
      return t(
        'settings.azureDevOps.cliLoginRequired',
        'Run az login on this host for your organization’s tenant, then Re-check.'
      )
    case 'cli-timeout':
      return t(
        'settings.azureDevOps.cliTimeout',
        'Azure CLI timed out. Check that az responds on this host, then Re-check.'
      )
    case 'invalid-token-response':
      return t(
        'settings.azureDevOps.cliInvalidResponse',
        'Update Azure CLI on this host so it returns UTC token expiry metadata, then Re-check.'
      )
    case 'unsupported-endpoint':
      return t(
        'settings.azureDevOps.cliUnsupportedEndpoint',
        'Azure CLI works only with Azure DevOps Services. Check the API URL or switch to Environment variables for Azure DevOps Server.'
      )
    case 'unauthorized':
      return t(
        'settings.azureDevOps.cliUnauthorized',
        'Azure DevOps rejected this sign-in. Check the active Azure CLI account and tenant, then Re-check.'
      )
    case 'forbidden':
      return t(
        'settings.azureDevOps.cliForbidden',
        'Check that the active Azure CLI account has access to this Azure DevOps organization, then Re-check.'
      )
    case 'network-error':
      return t(
        'settings.azureDevOps.cliNetworkError',
        'Check that this host can reach the configured Azure DevOps API URL, then Re-check.'
      )
    case 'token-acquisition-failed':
    case undefined:
      return t(
        'settings.azureDevOps.cliAcquisitionFailed',
        'Azure CLI could not provide an access token. Check that az is up to date and signed in on this host, then Re-check.'
      )
  }
}

export function AzureDevOpsIntegrationCard({
  state,
  hostLabel,
  onRefresh,
  onSave
}: {
  state: AzureDevOpsHostAuth
  hostLabel: string
  onRefresh?: () => void
  onSave: (method: AzureDevOpsAuthMethod) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const { phase, method, status, checking, saving, saveFailed } = state
  const cli = method === 'azure-cli'
  const credentialState =
    status?.credentialState ??
    (status?.authenticated
      ? 'authenticated'
      : status?.configured && status.tokenConfigured
        ? status.baseUrl
          ? 'error'
          : 'credential-ready'
        : status?.configured
          ? 'configured'
          : 'not-configured')
  const unavailable = phase === 'unavailable' || !status
  const statusLabel = unavailable
    ? t('settings.azureDevOps.unavailable', 'Unavailable')
    : credentialState === 'authenticated'
      ? t('settings.azureDevOps.verified', 'Organization verified')
      : credentialState === 'credential-ready'
        ? t('settings.azureDevOps.credentialReady', 'Credential ready')
        : credentialState === 'configured'
          ? t(
              'auto.components.settings.token.source.control.integration.cards.statusConfigured',
              'Configured'
            )
          : credentialState === 'error'
            ? t('settings.azureDevOps.authFailed', 'Auth failed')
            : t('settings.azureDevOps.notConfigured', 'Not configured')
  const help =
    phase === 'unsupported'
      ? t(
          'settings.azureDevOps.upgrade',
          'Upgrade the Orca runtime on this host to choose a different authentication method.'
        )
      : phase === 'unavailable'
        ? t(
            'settings.azureDevOps.hostUnavailable',
            'Azure DevOps authentication settings or status are unavailable on this host.'
          )
        : phase === 'loading'
          ? null
          : cli
            ? t(
                'settings.azureDevOps.cliSetup',
                'Uses the Azure CLI account on this host. Run az login, select an account in your Azure DevOps organization’s tenant, then Re-check. Orca does not change your Azure CLI account.'
              )
            : t(
                'settings.azureDevOps.envSetup',
                'Set ORCA_AZURE_DEVOPS_TOKEN for a personal access token or ORCA_AZURE_DEVOPS_ACCESS_TOKEN for a bearer token. Set ORCA_AZURE_DEVOPS_API_BASE_URL only when Orca cannot derive the API URL from the Git remote. Restart Orca on this host after changing environment variables.'
              )
  const detail = unavailable
    ? null
    : credentialState === 'credential-ready'
      ? cli
        ? t(
            'settings.azureDevOps.cliReady',
            'Azure CLI token available; organization access has not been verified.'
          )
        : t(
            'settings.azureDevOps.envReady',
            'Environment token available; organization access has not been verified.'
          )
      : credentialState === 'error'
        ? cli
          ? cliRecovery(status?.errorCode, t)
          : t(
              'settings.azureDevOps.envFailed',
              'Check the token, API URL, and repository permissions.'
            )
        : credentialState === 'authenticated'
          ? (status?.account ?? status?.baseUrl)
          : null

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name="Azure DevOps"
      description={t(
        'settings.azureDevOps.description',
        'Pull requests and build statuses via the Azure DevOps REST API.'
      )}
      statusLabel={statusLabel}
      statusTone={
        unavailable || credentialState === 'credential-ready'
          ? 'neutral'
          : credentialState === 'authenticated'
            ? 'connected'
            : 'attention'
      }
      checking={checking}
      actions={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={!onRefresh || checking || saving}
        >
          {t('settings.azureDevOps.recheck', 'Re-check')}
        </Button>
      }
    >
      <IntegrationCardDetails>
        <SettingsRow
          className="py-0"
          label={t('settings.azureDevOps.method', 'Authentication method')}
          htmlFor={id}
          description={t('settings.azureDevOps.host', 'Credential host: {{host}}', {
            host: hostLabel
          })}
          control={
            <Select
              value={method ?? ''}
              onValueChange={(value) => {
                if (value === 'environment' || value === 'azure-cli') {
                  onSave(value)
                }
              }}
              disabled={phase !== 'ready' || checking || saving}
            >
              <SelectTrigger id={id} size="sm" density="compact">
                <SelectValue
                  placeholder={
                    checking
                      ? t('settings.azureDevOps.loading', 'Loading…')
                      : t('settings.azureDevOps.unavailable', 'Unavailable')
                  }
                />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value="environment">
                  {t('settings.azureDevOps.environment', 'Environment variables')}
                </SelectItem>
                <SelectItem value="azure-cli">
                  {t('settings.azureDevOps.cli', 'Azure CLI')}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t('settings.azureDevOps.saving', 'Saving authentication method…')}
          </p>
        ) : null}
        {saveFailed ? (
          <p role="alert" className="text-xs text-destructive">
            {t(
              'settings.azureDevOps.saveFailed',
              'The host did not confirm the change. Re-check before trying again.'
            )}
          </p>
        ) : null}
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
        {detail ? (
          <p className="break-words text-xs text-muted-foreground" role="status">
            {detail}
          </p>
        ) : null}
        {phase === 'ready' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) =>
              openAppHttpLink(
                cli
                  ? 'https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli'
                  : 'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate',
                { event }
              )
            }
          >
            <ExternalLink className="size-3.5" />
            {t('settings.azureDevOps.learnMore', 'Learn more')}
          </Button>
        ) : null}
      </IntegrationCardDetails>
    </IntegrationCardShell>
  )
}
