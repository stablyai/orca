import { ExternalLink, GitPullRequestArrow, LoaderCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { AzureDevOpsStatus } from './integrations-pane-status'

type AzureDevOpsIntegrationCardProps = {
  azureDevOpsStatus: AzureDevOpsStatus
  azureDevOpsAccount: string | null
  azureDevOpsBaseUrl: string | null
  onRefreshAzureDevOps: () => void
}

export function AzureDevOpsIntegrationCard({
  azureDevOpsStatus,
  azureDevOpsAccount,
  azureDevOpsBaseUrl,
  onRefreshAzureDevOps: handleRefreshAzureDevOps
}: AzureDevOpsIntegrationCardProps): React.JSX.Element {
  return (
    <>
      {/* Azure DevOps */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <GitPullRequestArrow className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.5efce6953d', 'Azure DevOps')}
            </p>
            <p className="text-xs text-muted-foreground">
              {azureDevOpsStatus === 'configured'
                ? azureDevOpsAccount
                  ? translate(
                      'auto.components.settings.IntegrationsPane.277fc23929',
                      '{{value0}} · Pull requests and build statuses',
                      { value0: azureDevOpsAccount }
                    )
                  : azureDevOpsBaseUrl
                    ? translate(
                        'auto.components.settings.IntegrationsPane.277fc23929',
                        '{{value0}} · Pull requests and build statuses',
                        { value0: azureDevOpsBaseUrl }
                      )
                    : translate(
                        'auto.components.settings.IntegrationsPane.e3d5a24979',
                        'Pull requests and build statuses for detected Azure Repos'
                      )
                : translate(
                    'auto.components.settings.IntegrationsPane.6791d7af95',
                    'Pull requests and build statuses via Azure DevOps REST API tokens.'
                  )}
            </p>
          </div>
          {azureDevOpsStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : azureDevOpsStatus === 'configured' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {azureDevOpsAccount
                ? translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')
                : translate('auto.components.settings.IntegrationsPane.e7a961e1c5', 'Configured')}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {azureDevOpsStatus === 'not-configured'
                ? translate(
                    'auto.components.settings.IntegrationsPane.f92fbf11aa',
                    'Not configured'
                  )
                : translate('auto.components.settings.IntegrationsPane.45bf5e6e4b', 'Auth failed')}
            </span>
          )}
        </div>

        {azureDevOpsStatus !== 'checking' && azureDevOpsStatus !== 'configured' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {azureDevOpsStatus === 'not-configured' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate('auto.components.settings.IntegrationsPane.4ee74d1470', 'Set')}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.5ee6ef6405',
                      'ORCA_AZURE_DEVOPS_TOKEN'
                    )}
                  </span>
                  {translate('auto.components.settings.IntegrationsPane.ce3c58cd63', ', or set')}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.8f960935c1',
                      'ORCA_AZURE_DEVOPS_ACCESS_TOKEN'
                    )}
                  </span>
                  {translate('auto.components.settings.IntegrationsPane.67a9f26a80', '. Set')}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.ae6b7f5f40',
                      'ORCA_AZURE_DEVOPS_API_BASE_URL'
                    )}
                  </span>{' '}
                  {translate(
                    'auto.components.settings.IntegrationsPane.6f317f5132',
                    'only when Orca cannot derive the API base URL from the git remote.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl(
                        'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate'
                      )
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshAzureDevOps}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.953b7bf6f7',
                    'Azure DevOps credentials are configured but could not authenticate. Check the token, API base URL, and repository permissions, then restart Orca if environment variables changed.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl(
                        'https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests'
                      )
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshAzureDevOps}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
