import { ExternalLink, GitPullRequestArrow, LoaderCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { BitbucketStatus } from './integrations-pane-status'

type BitbucketIntegrationCardProps = {
  bitbucketStatus: BitbucketStatus
  bitbucketAccount: string | null
  onRefreshBitbucket: () => void
}

export function BitbucketIntegrationCard({
  bitbucketStatus,
  bitbucketAccount,
  onRefreshBitbucket: handleRefreshBitbucket
}: BitbucketIntegrationCardProps): React.JSX.Element {
  return (
    <>
      {/* Bitbucket */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <GitPullRequestArrow className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.8489c0aa49', 'Bitbucket')}
            </p>
            <p className="text-xs text-muted-foreground">
              {bitbucketStatus === 'connected'
                ? bitbucketAccount
                  ? translate(
                      'auto.components.settings.IntegrationsPane.277fc23929',
                      '{{value0}} · Pull requests and build statuses',
                      { value0: bitbucketAccount }
                    )
                  : translate(
                      'auto.components.settings.IntegrationsPane.9707523939',
                      'Pull requests and build statuses'
                    )
                : translate(
                    'auto.components.settings.IntegrationsPane.0879860c58',
                    'Pull requests and build statuses via Bitbucket Cloud API tokens.'
                  )}
            </p>
          </div>
          {bitbucketStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : bitbucketStatus === 'connected' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {bitbucketStatus === 'not-configured'
                ? translate(
                    'auto.components.settings.IntegrationsPane.f92fbf11aa',
                    'Not configured'
                  )
                : translate('auto.components.settings.IntegrationsPane.45bf5e6e4b', 'Auth failed')}
            </span>
          )}
        </div>

        {bitbucketStatus !== 'checking' && bitbucketStatus !== 'connected' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {bitbucketStatus === 'not-configured' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate('auto.components.settings.IntegrationsPane.4ee74d1470', 'Set')}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.b8a7efb3f6',
                      'ORCA_BITBUCKET_EMAIL'
                    )}
                  </span>{' '}
                  {translate('auto.components.settings.IntegrationsPane.a6c2816115', 'and')}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.44cde4aa01',
                      'ORCA_BITBUCKET_API_TOKEN'
                    )}
                  </span>
                  {translate('auto.components.settings.IntegrationsPane.ce3c58cd63', ', or set')}{' '}
                  <span className="font-mono text-[11px]">
                    {translate(
                      'auto.components.settings.IntegrationsPane.6e0ff3403e',
                      'ORCA_BITBUCKET_ACCESS_TOKEN'
                    )}
                  </span>
                  .
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl(
                        'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'
                      )
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshBitbucket}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.3c3cf05c63',
                    'Bitbucket credentials are configured but could not authenticate. Check the token and repository permissions, then restart Orca if environment variables changed.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl(
                        'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/'
                      )
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshBitbucket}>
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
