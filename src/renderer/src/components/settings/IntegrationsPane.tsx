/* eslint-disable max-lines -- Why: this pane co-locates source-host and
   Linear integration cards so the preflight-check + status-badge +
   install/auth-prompt scaffolding lives in one place rather than fanning
   out across per-integration files that would each repeat the same
   pattern. Splitting buys nothing while the surface stays this narrow. */
import { useEffect, useState } from 'react'
import {
  Github,
  Gitlab,
  GitPullRequestArrow,
  ExternalLink,
  LoaderCircle,
  Terminal,
  Unlink,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { LinearApiKeyDialog } from '@/components/linear-api-key-dialog'
import {
  getPreflightIntegrationStatuses,
  type PreflightRefreshProvider
} from './integrations-pane-status'
import { JiraIntegrationCard } from './jira-integration-card'
import { translate } from '@/i18n/i18n'
export { getIntegrationsPaneSearchEntries } from './integrations-search'

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

export function IntegrationsPane(): React.JSX.Element {
  const linearStatus = useAppStore((s) => s.linearStatus)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const disconnectLinear = useAppStore((s) => s.disconnectLinear)
  const disconnectLinearWorkspace = useAppStore((s) => s.disconnectLinearWorkspace)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const testLinearConnection = useAppStore((s) => s.testLinearConnection)
  const linearWorkspaces = linearStatus.workspaces ?? []
  const mountedRef = useMountedRef()

  const [refreshingPreflightProviders, setRefreshingPreflightProviders] = useState<
    Set<PreflightRefreshProvider>
  >(new Set())
  const [linearDialogOpen, setLinearDialogOpen] = useState(false)
  const [linearTestingWorkspaceId, setLinearTestingWorkspaceId] = useState<string | null>(null)
  const [linearTestResultByWorkspace, setLinearTestResultByWorkspace] = useState<
    Record<string, { state: 'ok' | 'error'; error?: string }>
  >({})

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

  const handleLinearDisconnect = async (workspaceId?: string): Promise<void> => {
    await (workspaceId ? disconnectLinearWorkspace(workspaceId) : disconnectLinear())
    if (!mountedRef.current) {
      return
    }
    setLinearTestResultByWorkspace({})
  }

  // Why: explicit user-triggered verification. This is the *only* path in
  // settings that decrypts the stored API key, so the macOS Keychain prompt
  // (if the app signature has changed since the item was stored) only
  // appears when the user clicks Test — not just for opening Settings.
  const handleLinearTest = async (workspaceId: string): Promise<void> => {
    setLinearTestingWorkspaceId(workspaceId)
    setLinearTestResultByWorkspace((prev) => {
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    const result = await testLinearConnection(workspaceId)
    if (!mountedRef.current) {
      return
    }
    if (result.ok) {
      setLinearTestResultByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: { state: 'ok' }
      }))
    } else {
      setLinearTestResultByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: { state: 'error', error: result.error }
      }))
    }
    setLinearTestingWorkspaceId(null)
  }

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

      {/* Linear */}
      <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3">
          <LinearIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">
              {translate('auto.components.settings.IntegrationsPane.264a9b6128', 'Linear')}
            </p>
            <p className="text-xs text-muted-foreground">
              {linearStatus.connected
                ? translate(
                    'auto.components.settings.IntegrationsPane.98ded79cd7',
                    '{{value0}} workspace{{value1}} connected',
                    {
                      value0: linearWorkspaces.length,
                      value1: linearWorkspaces.length === 1 ? '' : 's'
                    }
                  )
                : translate(
                    'auto.components.settings.IntegrationsPane.33ae9730a8',
                    'Add Linear access to browse and link issues.'
                  )}
            </p>
          </div>
          {linearStatus.connected ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => setLinearDialogOpen(true)}>
                {translate(
                  'auto.components.settings.IntegrationsPane.077844591a',
                  'Add workspace access'
                )}
              </Button>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                {translate('auto.components.settings.IntegrationsPane.6432f6522e', 'Connected')}
              </span>
            </div>
          ) : (
            <button
              className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setLinearDialogOpen(true)}
            >
              {translate(
                'auto.components.settings.IntegrationsPane.f5c5246514',
                'Add Linear access'
              )}
            </button>
          )}
        </div>

        {linearStatus.connected && (
          <div className="mt-3 space-y-2">
            {linearWorkspaces.map((workspace) => {
              const testResult = linearTestResultByWorkspace[workspace.id]
              const testing = linearTestingWorkspaceId === workspace.id
              return (
                <div
                  key={workspace.id}
                  className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {workspace.organizationName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {workspace.displayName}
                      {workspace.email ? ` · ${workspace.email}` : ''}
                    </p>
                  </div>
                  {testResult?.state === 'ok' ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5" />
                      {translate(
                        'auto.components.settings.IntegrationsPane.fe4d378dc4',
                        'Verified'
                      )}
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
                    onClick={() => void handleLinearTest(workspace.id)}
                    disabled={testing}
                  >
                    {testing ? (
                      <>
                        <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                        {translate(
                          'auto.components.settings.IntegrationsPane.e7b2dd46f9',
                          'Testing…'
                        )}
                      </>
                    ) : (
                      translate('auto.components.settings.IntegrationsPane.95b9a87e7e', 'Test')
                    )}
                  </Button>
                  <button
                    onClick={() => void handleLinearDisconnect(workspace.id)}
                    aria-label={translate(
                      'auto.components.settings.IntegrationsPane.8e078e480c',
                      'Disconnect {{value0}}',
                      { value0: workspace.organizationName }
                    )}
                    className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                  >
                    <Unlink className="size-3.5" />
                  </button>
                </div>
              )
            })}
            <p className="text-[11px] text-muted-foreground/70">
              {translate(
                'auto.components.settings.IntegrationsPane.2122e15517',
                'Each connected Linear workspace has one key stored by the active runtime. Full-access keys can cover all teams the key owner can access; restricted keys can be replaced any time.'
              )}
            </p>
          </div>
        )}
      </div>

      <JiraIntegrationCard />

      <LinearApiKeyDialog
        open={linearDialogOpen}
        onOpenChange={setLinearDialogOpen}
        connectLabel="Add Linear access"
        onConnected={() => setLinearTestResultByWorkspace({})}
      />
    </div>
  )
}
