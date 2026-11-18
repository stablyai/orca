import { translate } from '@/i18n/i18n'
import {
  BOT_GITHUB_OFF,
  GITHUB_BOT_MENTION,
  type ConnectorGitHubInstallation
} from '../../../../../shared/connector-bot-github-contract'
import type { Bot } from '../../../../../shared/bot-types'
import { HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { hostSetupErrorMessage } from '../bot-host-copy'

/** What to tell the owner for a GitHub error code, the cloud's or the host's; `hostName` names a server. */
export function botGitHubErrorMessage(code: string, hostName: string | null): string {
  const onHost = hostSetupErrorMessage(code, 'GitHub', hostName)
  if (onHost) {
    return onHost
  }
  switch (code) {
    case BOT_GITHUB_OFF:
      return translate('bots.github.errors.off', 'GitHub is coming soon.')
    case 'expired':
      return translate(
        'bots.github.errors.replaced',
        'GitHub didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
      )
    case 'already_linked':
      return translate(
        'bots.github.errors.alreadyLinked',
        'This Orca account is linked to another GitHub user. Unlink it in Settings › Bots › GitHub first.'
      )
    case 'wrong_account':
      return translate(
        'bots.github.errors.wrongAccount',
        'This sign-in was started from another Orca account. Sign in with GitHub again from this one.'
      )
    case 'rate_limited':
      return translate(
        'bots.github.errors.rateLimited',
        'Too many tries. Wait a minute, then try again.'
      )
    case 'github_unavailable':
      return translate('bots.github.errors.unavailable', 'GitHub did not answer. Try again.')
    case 'signed_out':
      return translate('bots.github.errors.signedOut', 'Sign in to Orca to connect GitHub.')
    case 'cloud_unreachable':
      return translate(
        'bots.github.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** "How to ask", the same wherever it shows; render it with BotHowToAsk. */
export function gitHubHowToAsk(bot: Bot): string {
  return translate(
    'bots.github.howToAsk',
    'Mention <code>{{mention}} {{handle}} …</code> on an issue or pull request.',
    { mention: GITHUB_BOT_MENTION, handle: bot.folder, ...HOW_TO_ASK_ESCAPED }
  )
}

/** An installation as the owner picked it on GitHub: its repositories, or the whole account. */
export function gitHubInstallationLabel(installation: ConnectorGitHubInstallation): string {
  return installation.repositories === null
    ? translate('bots.github.allRepositories', 'All repositories of {{account}}', {
        account: installation.accountLogin
      })
    : installation.repositories.map((repository) => repository.fullName).join(', ')
}

/** Whose git login the bot pushes with, and from where. */
export function gitHubPushesAs(bot: Pick<Bot, 'name'>, hostName: string | null): string {
  return hostName
    ? translate(
        'bots.github.setup.pushesOnHost',
        '{{name}} pushes code from {{host}} with its git login.',
        {
          name: bot.name,
          host: hostName
        }
      )
    : translate(
        'bots.github.setup.pushesAsYou',
        '{{name}} pushes code from this computer with your own git login.',
        { name: bot.name }
      )
}

/** What to type on an issue or pull request to ask the bot. */
export function gitHubMention(bot: Pick<Bot, 'folder'>): string {
  return `${GITHUB_BOT_MENTION} ${bot.folder}`
}

/** One line for the installs, e.g. "3 repositories in stablyai"; the full list is gitHubInstallationLabel. */
export function gitHubInstallationsSummary(
  installations: readonly ConnectorGitHubInstallation[]
): string {
  const repositories = installations.flatMap((installation) => installation.repositories ?? [])
  if (installations.length === 1 && (installations[0].repositories?.length ?? 0) <= 1) {
    return gitHubInstallationLabel(installations[0])
  }
  const accounts = installations.map((installation) => installation.accountLogin).join(', ')
  return installations.some((installation) => installation.repositories === null)
    ? translate('bots.github.repositoriesIn', 'Repositories in {{accounts}}', { accounts })
    : translate('bots.github.repositoryCount', '{{count}} repositories in {{accounts}}', {
        count: repositories.length,
        accounts,
        defaultValue_one: '{{count}} repository in {{accounts}}'
      })
}
