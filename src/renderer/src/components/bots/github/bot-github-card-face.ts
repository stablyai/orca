import type { BotConnectorStatus } from '../bot-connector-row-parts'
import { translate } from '@/i18n/i18n'
import type { BotGitHubView } from '@/lib/bot-github-state'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { botGitHubErrorMessage, gitHubInstallationLabel } from './bot-github-copy'

export type GitHubCardFace = {
  /** The org, or GitHub as a whole until it is linked and installed. */
  place: string
  description: string
  status: BotConnectorStatus | null
  /** Linked and installed; otherwise setup can be finished from the card. */
  ready: boolean
}

/** An org's row: where the app may work there, and who is signed in. */
export function gitHubInstallationFace(
  installation: ConnectorGitHubInstallation,
  login: string
): GitHubCardFace {
  const repos =
    installation.repositories === null
      ? translate('bots.github.allRepositoriesShort', 'all repositories')
      : installation.repositories
          .map((repository) => repository.fullName.split('/').pop() ?? repository.fullName)
          .join(', ')
  return {
    place: installation.accountLogin,
    description: translate(
      'bots.github.connection.orgDescription',
      '{{repos}} · signed in as @{{login}}',
      { repos, login }
    ),
    status: null,
    ready: true
  }
}

export function gitHubCardFace(view: BotGitHubView, hostName: string | null): GitHubCardFace {
  return { place: 'GitHub', ...gitHubStateFace(view, hostName) }
}

function gitHubStateFace(
  view: BotGitHubView,
  hostName: string | null
): Omit<GitHubCardFace, 'place'> {
  if (view.status === 'loading') {
    return {
      description: translate('bots.github.setup.checking', 'Checking GitHub…'),
      status: {
        label: translate('settings.bots.githubStatus.checking', 'Checking'),
        tone: 'neutral'
      },
      ready: false
    }
  }
  if (view.status === 'failed' && view.error === BOT_SLACK_DESKTOP_ERRORS.signedOut) {
    return { ...signedOutConnectorFace(), ready: false }
  }
  if (view.status !== 'ready') {
    return {
      description: botGitHubErrorMessage(
        view.status === 'off' ? 'github_off' : view.error,
        hostName
      ),
      status: {
        label: translate('settings.bots.githubStatus.unknown', 'Can’t check'),
        tone: 'neutral'
      },
      ready: false
    }
  }
  const { account, installations } = view.github
  if (!account) {
    return {
      description: translate(
        'bots.github.connection.unlinked',
        'Sign in with GitHub to link your GitHub account.'
      ),
      status: {
        label: translate('settings.bots.githubStatus.unlinked', 'Not linked'),
        tone: 'attention'
      },
      ready: false
    }
  }
  if (installations.length === 0) {
    return {
      description: translate(
        'bots.github.connection.notInstalled',
        'Signed in as @{{login}}. Install the Orca app on the repositories it may work in.',
        { login: account.login }
      ),
      status: {
        label: translate('settings.bots.githubStatus.notInstalled', 'Orca not installed'),
        tone: 'attention'
      },
      ready: false
    }
  }
  return {
    description: translate(
      'bots.github.connection.description',
      '{{repos}} · signed in as @{{login}}',
      { repos: installations.map(gitHubInstallationLabel).join(', '), login: account.login }
    ),
    status: null,
    ready: true
  }
}
