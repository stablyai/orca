import { useEffect, useState } from 'react'
import { ExternalLink, Github, Gitlab, LoaderCircle, Terminal } from 'lucide-react'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  getPreflightIntegrationStatuses,
  type PreflightRefreshProvider
} from './integrations-pane-status'
import { EnvironmentTokenIntegrationCards } from './environment-token-integration-cards'
import { JiraIntegrationCard } from './jira-integration-card'
import { LinearIntegrationCard } from './linear-integration-card'
import { translate } from '@/i18n/i18n'
export { getIntegrationsPaneSearchEntries } from './integrations-search'

export function IntegrationsPane(): React.JSX.Element {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const mountedRef = useMountedRef()

  const [refreshingPreflightProviders, setRefreshingPreflightProviders] = useState<
    Set<PreflightRefreshProvider>
  >(new Set())

  useEffect(() => {
    void checkLinearConnection()
    void refreshPreflightStatus()
  }, [checkLinearConnection, refreshPreflightStatus])

  const {
    ghStatus,
    glabStatus,
    bitbucketStatus,
    bitbucketAccount,
    azureDevOpsStatus,
    azureDevOpsAccount,
    azureDevOpsBaseUrl,
    giteaStatus,
    giteaAccount,
    giteaBaseUrl
  } = getPreflightIntegrationStatuses(preflightStatus, refreshingPreflightProviders)

  const refreshPreflightProvider = (provider: PreflightRefreshProvider): void => {
    setRefreshingPreflightProviders((prev) => new Set(prev).add(provider))
    void refreshPreflightStatus({ force: true }).finally(() => {
      if (!mountedRef.current) {
        return
      }
      setRefreshingPreflightProviders((prev) => {
        if (!prev.has(provider)) {
          return prev
        }
        const next = new Set(prev)
        next.delete(provider)
        return next
      })
    })
  }

  const handleRefreshGlab = (): void => refreshPreflightProvider('glab')

  const handleRefreshGh = (): void => refreshPreflightProvider('gh')

  const handleRefreshBitbucket = (): void => refreshPreflightProvider('bitbucket')

  const handleRefreshAzureDevOps = (): void => refreshPreflightProvider('azureDevOps')

  const handleRefreshGitea = (): void => refreshPreflightProvider('gitea')

  return (
    <div className="space-y-3">
      {/* GitHub */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <Github className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.70c5f74f36', 'GitHub')}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.IntegrationsPane.de6a0d13ab',
                'Pull requests, issues, and checks via the'
              )}{' '}
              <span className="font-mono text-[11px]">
                {translate('auto.components.settings.IntegrationsPane.f36365ed45', 'gh')}
              </span>{' '}
              {translate('auto.components.settings.IntegrationsPane.ea160a9978', 'CLI.')}
            </p>
          </div>
          {ghStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : ghStatus === 'connected' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {ghStatus === 'not-installed'
                ? translate('auto.components.settings.IntegrationsPane.f7eb5f0b24', 'Not installed')
                : translate(
                    'auto.components.settings.IntegrationsPane.15cf990798',
                    'Not authenticated'
                  )}
            </span>
          )}
        </div>

        {ghStatus !== 'checking' && ghStatus !== 'connected' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {ghStatus === 'not-installed' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.c0c8575e05',
                    'Install the GitHub CLI to enable pull requests, issues, and checks.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.api.shell.openUrl('https://cli.github.com')}
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.399cf46867',
                      'Install GitHub CLI'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGh}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.09285e9fe6',
                    'The GitHub CLI is installed but not authenticated. Run this command in a terminal:'
                  )}
                </p>
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                  {translate(
                    'auto.components.settings.IntegrationsPane.51000487c4',
                    'gh auth login'
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl('https://cli.github.com/manual/gh_auth_login')
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGh}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* GitLab */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <Gitlab className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.513abfe47d', 'GitLab')}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.IntegrationsPane.027440e1cb',
                'Merge requests, issues, todos, and pipelines via the'
              )}{' '}
              <span className="font-mono text-[11px]">
                {translate('auto.components.settings.IntegrationsPane.a3326f6f1b', 'glab')}
              </span>{' '}
              {translate('auto.components.settings.IntegrationsPane.ea160a9978', 'CLI.')}
            </p>
          </div>
          {glabStatus === 'checking' ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : glabStatus === 'connected' ? (
            <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')}
            </span>
          ) : (
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              {glabStatus === 'not-installed'
                ? translate('auto.components.settings.IntegrationsPane.f7eb5f0b24', 'Not installed')
                : translate(
                    'auto.components.settings.IntegrationsPane.15cf990798',
                    'Not authenticated'
                  )}
            </span>
          )}
        </div>

        {glabStatus !== 'checking' && glabStatus !== 'connected' && (
          <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5 space-y-2">
            {glabStatus === 'not-installed' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.35a3379372',
                    'Install the GitLab CLI to enable merge requests, issues, and pipelines.'
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl('https://gitlab.com/gitlab-org/cli#installation')
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.a83cac5726',
                      'Install GitLab CLI'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGlab}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.IntegrationsPane.05e5245af7',
                    'The GitLab CLI is installed but not authenticated. Run this command in a terminal:'
                  )}
                </p>
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                  {translate(
                    'auto.components.settings.IntegrationsPane.e74de656ce',
                    'glab auth login'
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.api.shell.openUrl(
                        'https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/login.md'
                      )
                    }
                  >
                    <ExternalLink className="size-3.5 mr-1.5" />
                    {translate(
                      'auto.components.settings.IntegrationsPane.01f6c7582e',
                      'Learn more'
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={handleRefreshGlab}>
                    {translate('auto.components.settings.IntegrationsPane.4831ba1083', 'Re-check')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <EnvironmentTokenIntegrationCards
        bitbucketStatus={bitbucketStatus}
        bitbucketAccount={bitbucketAccount}
        azureDevOpsStatus={azureDevOpsStatus}
        azureDevOpsAccount={azureDevOpsAccount}
        azureDevOpsBaseUrl={azureDevOpsBaseUrl}
        giteaStatus={giteaStatus}
        giteaAccount={giteaAccount}
        giteaBaseUrl={giteaBaseUrl}
        onRefreshBitbucket={handleRefreshBitbucket}
        onRefreshAzureDevOps={handleRefreshAzureDevOps}
        onRefreshGitea={handleRefreshGitea}
      />

      <LinearIntegrationCard />

      <JiraIntegrationCard />
    </div>
  )
}
