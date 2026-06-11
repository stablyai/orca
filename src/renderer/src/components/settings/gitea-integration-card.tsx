import { ExternalLink, GitPullRequestArrow, LoaderCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { GiteaStatus } from './integrations-pane-status'

type GiteaIntegrationCardProps = {
  giteaStatus: GiteaStatus
  giteaAccount: string | null
  giteaBaseUrl: string | null
  onRefreshGitea: () => void
}

export function GiteaIntegrationCard({
  giteaStatus,
  giteaAccount,
  giteaBaseUrl,
  onRefreshGitea: handleRefreshGitea
}: GiteaIntegrationCardProps): React.JSX.Element {
  return (
    <>
      {/* Gitea */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <GitPullRequestArrow className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.4ab9b96925', 'Gitea')}
            </p>
            <p className="text-xs text-muted-foreground">
              {giteaStatus === 'configured'
                ? giteaAccount
                  ? translate(
                      'auto.components.settings.IntegrationsPane.1fac9b4910',
                      '{{value0}} · Pull requests and commit statuses',
                      { value0: giteaAccount }
                    )
                  : giteaBaseUrl
                    ? translate(
                        'auto.components.settings.IntegrationsPane.1fac9b4910',
                        '{{value0}} · Pull requests and commit statuses',
                        { value0: giteaBaseUrl }
                      )
                    : translate(
                        'auto.components.settings.IntegrationsPane.6355fe585e',
                        'Pull requests and commit statuses for detected repositories'
                      )
                : translate(
                    'auto.components.settings.IntegrationsPane.6bd148dcb5',
                    'Pull requests and commit statuses via the Gitea REST API.'
                  )}
            </p>
          </div>
          {giteaStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : giteaStatus === 'configured' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {giteaAccount
                ? translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')
                : translate('auto.components.settings.IntegrationsPane.e7a961e1c5', 'Configured')}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {giteaStatus === 'not-configured'
                ? translate(
                    'auto.components.settings.IntegrationsPane.e1bd5364e6',
                    'Optional setup'
                  )
                : translate('auto.components.settings.IntegrationsPane.45bf5e6e4b', 'Auth failed')}
            </span>
          )}
        </div>

        {giteaStatus !== 'checking' && giteaStatus !== 'configured' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {giteaStatus === 'not-configured' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.d9467ab026',
                    'Public repositories are detected from their git remote. Set'
                  )}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.e678d89e8c',
                      'ORCA_GITEA_TOKEN'
                    )}
                  </span>{' '}
                  {translate(
                    'auto.components.settings.IntegrationsPane.2c0330ec3e',
                    'for private repositories, and set'
                  )}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.6193444689',
                      'ORCA_GITEA_API_BASE_URL'
                    )}
                  </span>{' '}
                  {translate(
                    'auto.components.settings.IntegrationsPane.5a1f86225a',
                    'only when Orca cannot derive the API URL from the remote.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl('https://docs.gitea.com/next/development/api-usage')
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGitea}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.1a62c295c6',
                    'Gitea credentials are configured but could not authenticate. Check the token, API base URL, and repository permissions, then restart Orca if environment variables changed.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl('https://docs.gitea.com/next/development/api-usage')
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGitea}>
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
