import React from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { type BotGitHubView, useBotGitHub } from '@/lib/bot-github-state'
import { botMemberSource, type Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotConnectorRow } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { botGitHubErrorMessage, gitHubHowToAsk, gitHubInstallationLabel } from './bot-github-copy'
import type { ConnectorGitHubInstallation } from '../../../../../shared/connector-bot-github-contract'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { openGitHubInstall } from '@/lib/bot-github-install-record'
import { useGitHubWhoCanAsk } from './use-github-who-can-ask'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { signedOutConnectorFace } from '../orca-cloud-sign-in'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../../shared/connector-bot-slack-contract'

type GitHubCardFace = {
  /** The org, or GitHub as a whole until it is linked and installed. */
  place: string
  description: string
  status: { label: string; tone: IntegrationCardStatusTone } | null
  /** Linked and installed; otherwise setup can be finished from the card. */
  ready: boolean
}

/** An org's row: where the app may work there, and who is signed in. */
function gitHubInstallationFace(
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

/** One GitHub row's state and its people, for the row and for Who can ask. */
export function useGitHubCard(
  bot: Bot,
  installation: ConnectorGitHubInstallation | undefined
): { view: BotGitHubView; face: GitHubCardFace; people: BotWhoCanAskService } {
  const view = useBotGitHub(bot.hostId)
  const login = view.status === 'ready' ? view.github.account?.login : undefined
  const hostName = useBotHostLabel(bot.hostId)
  const face =
    installation && login
      ? gitHubInstallationFace(installation, login)
      : gitHubCardFace(view, hostName)
  const people = useGitHubWhoCanAsk(bot.hostId, face.ready, installation?.installationId)
  return { view, face, people }
}

/**
 * Settings › Bots › Connectors › one GitHub org: where the bot answers there, how to ask it, and its
 * GitHub people there with access. No installation: GitHub as a whole, until it is linked and installed.
 */
export function BotGitHubCard({
  bot,
  installation,
  title,
  defaultOpen
}: {
  bot: Bot
  installation?: ConnectorGitHubInstallation
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const { view, face, people } = useGitHubCard(bot, installation)

  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
        name: bot.name,
        place: face.place
      }),
      description: t(
        'bots.github.connection.removeNote',
        'People can no longer ask it on GitHub, and its GitHub people are cleared. The Orca app stays installed.'
      ),
      confirmLabel: t('bots.github.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const shown = view.status === 'ready' ? view.github.installations : []
    const removed = [
      ...(bot.github?.removedInstallationIds ?? []),
      ...(installation ? [installation.installationId] : [])
    ]
    const left = shown.filter((entry) => !removed.includes(entry.installationId))
    // The last org takes GitHub off the bot, as removing GitHub did before orgs had rows.
    await updateBot(
      bot,
      installation && left.length > 0
        ? {
            github: { removedInstallationIds: removed },
            members: bot.members.filter(
              (member) =>
                botMemberSource(member) !== 'github' ||
                member.workspaceId !== installation.installationId
            )
          }
        : {
            github: null,
            members: bot.members.filter((member) => botMemberSource(member) !== 'github')
          }
    ).catch((error: unknown) => toast.error(botErrorMessage(error)))
  }

  const installUrl = view.status === 'ready' ? view.github.installUrl : null
  // GitHub's install page, through the same setup as Add connector.
  const addAccess = useConnectorSetup(bot)
  const notReady = view.status === 'ready' && !face.ready
  return (
    <BotConnectorRow
      connector={{ id: 'github', Icon: GitHubIcon }}
      name={title ?? 'GitHub'}
      description={face.description}
      status={face.status}
      checking={view.status === 'loading'}
      fix={
        notReady
          ? {
              label: t('bots.github.connection.finishSetup', 'Finish setup'),
              onClick: () => openGitHubInstall(bot)
            }
          : null
      }
      bot={bot}
      howToAsk={gitHubHowToAsk(bot)}
      people={people}
      defaultOpen={defaultOpen}
      add={
        face.ready && installUrl
          ? { label: connectorAddAccessLabel('github'), onClick: () => addAccess.start('github') }
          : null
      }
      remove={{
        label: t('bots.connector.removeFrom', 'Remove from {{place}}…', {
          place: face.place
        }),
        onSelect: () => void remove()
      }}
    />
  )
}
