import { ExternalLink, Github, Gitlab, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { usePreflightCardStatuses } from './source-control-preflight-card-status'
import { translate } from '@/i18n/i18n'

export function GitHubIntegrationCard(): React.JSX.Element {
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('gh')
  const status = unavailable ? 'unavailable' : statuses.ghStatus
  const connected = status === 'connected'

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
      statusLabel={
        connected
          ? 'Connected'
          : status === 'unavailable'
            ? 'Unavailable'
            : status === 'not-installed'
              ? 'Not installed'
              : 'Not authenticated'
      }
    >
      {status !== 'checking' && !connected ? (
        <IntegrationCardDetails>
          {status === 'unavailable' ? (
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
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
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
          )}
        </IntegrationCardDetails>
      ) : null}
    </IntegrationCardShell>
  )
}

export function GitLabIntegrationCard(): React.JSX.Element {
  const { statuses, unavailable, refresh } = usePreflightCardStatuses('glab')
  const status = unavailable ? 'unavailable' : statuses.glabStatus
  const connected = status === 'connected'

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
      statusLabel={
        connected
          ? 'Connected'
          : status === 'unavailable'
            ? 'Unavailable'
            : status === 'not-installed'
              ? 'Not installed'
              : 'Not authenticated'
      }
    >
      {status !== 'checking' && !connected ? (
        <IntegrationCardDetails>
          {status === 'unavailable' ? (
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
              <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-xs">
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
          )}
        </IntegrationCardDetails>
      ) : null}
    </IntegrationCardShell>
  )
}
