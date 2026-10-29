import { useEffect, useState } from 'react'
import { ExternalLink, Github, Gitlab, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import {
  useIntegrationCommandRowClass,
  useIntegrationSubordinateRowClass
} from './integration-card-presentation'
import { getProviderAccountScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { usePreflightCardStatuses } from './source-control-preflight-card-status'
import {
  formatGitHostWebSchemesText,
  parseGitHostWebSchemesText
} from './git-host-web-schemes-text'
import { translate } from '@/i18n/i18n'

function integrationStatusLabel(
  status: 'connected' | 'unavailable' | 'not-installed' | 'not-authenticated' | 'checking'
): string {
  switch (status) {
    case 'connected':
      return translate(
        'auto.components.settings.cli.source.control.integration.cards.statusConnected',
        'Connected'
      )
    case 'unavailable':
      return translate(
        'auto.components.settings.cli.source.control.integration.cards.statusUnavailable',
        'Unavailable'
      )
    case 'not-installed':
      return translate(
        'auto.components.settings.cli.source.control.integration.cards.statusNotInstalled',
        'Not installed'
      )
    case 'not-authenticated':
      return translate(
        'auto.components.settings.cli.source.control.integration.cards.statusNotAuthenticated',
        'Not authenticated'
      )
    case 'checking':
      return ''
  }
}

function ProviderAccountScopeDetails({
  children
}: {
  children?: React.ReactNode
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const accountScope = getProviderAccountScope(settings)
  const subordinateRowClass = useIntegrationSubordinateRowClass('text-xs')

  return (
    <IntegrationCardDetails>
      <ProviderHostScopeControl
        labelPrefix={translate(
          'auto.components.settings.cli.source.control.integration.cards.account_scope_prefix',
          'Account scope'
        )}
        scope={accountScope}
        className={subordinateRowClass}
      />
      {children}
    </IntegrationCardDetails>
  )
}

export function GitHubIntegrationCard(): React.JSX.Element {
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('gh')
  const status = unavailable ? 'unavailable' : statuses.ghStatus
  const connected = status === 'connected'
  const commandRowClass = useIntegrationCommandRowClass()

  return (
    <IntegrationCardShell
      icon={<Github className="size-5" />}
      name="GitHub"
      description={
        <>
          {translate(
            'auto.components.settings.cli.source.control.integration.cards.b4d900e7f1',
            'Pull requests, issues, and checks via the'
          )}{' '}
          <span className="font-mono text-[11px]">
            {translate(
              'auto.components.settings.cli.source.control.integration.cards.6b2cfb52b4',
              'gh'
            )}
          </span>{' '}
          {translate(
            'auto.components.settings.cli.source.control.integration.cards.a47f71e357',
            'CLI.'
          )}
        </>
      }
      checking={status === 'checking'}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={integrationStatusLabel(status)}
    >
      <ProviderAccountScopeDetails>
        {status !== 'checking' && !connected ? (
          status === 'unavailable' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.6f30fc4216',
                  'GitHub CLI status is not available in this runtime yet.'
                )}
              </p>
              <Button variant="ghost" size="sm" onClick={refresh}>
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                  'Re-check'
                )}
              </Button>
            </>
          ) : status === 'not-installed' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.23cb5a0dee',
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
                    'auto.components.settings.cli.source.control.integration.cards.7755c28af5',
                    'Install GitHub CLI'
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  {translate(
                    'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                    'Re-check'
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.2e44dda68a',
                  'The GitHub CLI is installed but not authenticated. Run this command in a terminal:'
                )}
              </p>
              <div className={commandRowClass}>
                <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.8d90249d22',
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
                    'auto.components.settings.cli.source.control.integration.cards.8cbc39f862',
                    'Learn more'
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  {translate(
                    'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                    'Re-check'
                  )}
                </Button>
              </div>
            </>
          )
        ) : null}
      </ProviderAccountScopeDetails>
    </IntegrationCardShell>
  )
}

function GitHostWebSchemesField(): React.JSX.Element {
  const schemes = useAppStore((s) => s.settings?.gitHostWebSchemes)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [draft, setDraft] = useState(() => formatGitHostWebSchemesText(schemes))

  useEffect(() => {
    setDraft(formatGitHostWebSchemesText(schemes))
  }, [schemes])

  return (
    <div className="space-y-1.5">
      <Label htmlFor="git-host-web-schemes" className="text-xs font-medium">
        {translate(
          'auto.components.settings.cli.source.control.integration.cards.git_host_web_schemes_label',
          'Self-hosted web URL schemes'
        )}
      </Label>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.cli.source.control.integration.cards.git_host_web_schemes_help',
          'When git remotes use SSH but the forge web UI is HTTP-only, list one host per line as host=http (or host=https). Review/Open MR links use this scheme.'
        )}
      </p>
      <textarea
        id="git-host-web-schemes"
        value={draft}
        rows={3}
        spellCheck={false}
        className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="gitlab.company.test=http"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          void updateSettings({ gitHostWebSchemes: parseGitHostWebSchemesText(draft) })
        }}
      />
    </div>
  )
}

export function GitLabIntegrationCard(): React.JSX.Element {
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('glab')
  const status = unavailable ? 'unavailable' : statuses.glabStatus
  const connected = status === 'connected'
  const commandRowClass = useIntegrationCommandRowClass()

  return (
    <IntegrationCardShell
      icon={<Gitlab className="size-5" />}
      name="GitLab"
      description={
        <>
          {translate(
            'auto.components.settings.cli.source.control.integration.cards.1f2b347bd3',
            'Merge requests, issues, todos, and pipelines via the'
          )}{' '}
          <span className="font-mono text-[11px]">
            {translate(
              'auto.components.settings.cli.source.control.integration.cards.2a6b359e75',
              'glab'
            )}
          </span>{' '}
          {translate(
            'auto.components.settings.cli.source.control.integration.cards.a47f71e357',
            'CLI.'
          )}
        </>
      }
      checking={status === 'checking'}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={integrationStatusLabel(status)}
    >
      <ProviderAccountScopeDetails>
        <GitHostWebSchemesField />
        {status !== 'checking' && !connected ? (
          status === 'unavailable' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.faddeb763d',
                  'GitLab CLI status is not available in this runtime yet.'
                )}
              </p>
              <Button variant="ghost" size="sm" onClick={refresh}>
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                  'Re-check'
                )}
              </Button>
            </>
          ) : status === 'not-installed' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.b56fd5676a',
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
                    'auto.components.settings.cli.source.control.integration.cards.54a640af7a',
                    'Install GitLab CLI'
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  {translate(
                    'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                    'Re-check'
                  )}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.4be0616873',
                  'The GitLab CLI is installed but not authenticated. Run this command in a terminal:'
                )}
              </p>
              <div className={commandRowClass}>
                <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                {translate(
                  'auto.components.settings.cli.source.control.integration.cards.707180d09c',
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
                    'auto.components.settings.cli.source.control.integration.cards.8cbc39f862',
                    'Learn more'
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  {translate(
                    'auto.components.settings.cli.source.control.integration.cards.d5b3be8ecd',
                    'Re-check'
                  )}
                </Button>
              </div>
            </>
          )
        ) : null}
      </ProviderAccountScopeDetails>
    </IntegrationCardShell>
  )
}
