import React from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import { type BotGitHubView, useBotGitHub } from '@/lib/bot-github-state'
import { botMemberSource, type Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotConnectorRow } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { gitHubHowToAsk } from './bot-github-copy'
import {
  type ConnectorGitHubInstallation,
  gitHubLoginFor
} from '../../../../../shared/connector-bot-github-contract'
import { connectorAddAccessLabel } from '../bot-connectors'
import { useConnectorSetup } from '../ConnectorSetupDialogs'
import { addGitHubAccount, openGitHubInstall } from '@/lib/bot-github-install-record'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useGitHubWhoCanAsk } from './use-github-who-can-ask'
import { GhSignedOutLine, ghSignedOutStatus, useGhSignedOutHost } from './GhSignedOutLine'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { gitHubCardFace, gitHubInstallationFace, type GitHubCardFace } from './bot-github-card-face'

export { gitHubCardFace }

/** One GitHub row's state and its people, for the row and for Who can ask; `ghHost`: where gh is
 *  signed out, when it is. */
export function useGitHubCard(
  bot: Bot,
  installation: ConnectorGitHubInstallation | undefined
): {
  view: BotGitHubView
  face: GitHubCardFace
  people: BotWhoCanAskService
  ghHost: string | null
} {
  const view = useBotGitHub(bot.hostId)
  const login =
    view.status === 'ready' && installation
      ? gitHubLoginFor(view.github, installation.installationId)
      : null
  const hostName = useBotHostLabel(bot.hostId)
  const face =
    installation && login
      ? gitHubInstallationFace(installation, login)
      : gitHubCardFace(view, hostName)
  const people = useGitHubWhoCanAsk(bot.hostId, face.ready, installation?.installationId)
  const ghHost = useGhSignedOutHost(bot.hostId, view)
  return { view, face, people, ghHost }
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
  const { view, face, people, ghHost } = useGitHubCard(bot, installation)

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
  // A cloud that links several logins lists them; a paired web client can't start a sign-in.
  const signsIn =
    face.ready && view.status === 'ready' && !!view.github.accounts && !isPairedWebClientWindow()
  return (
    <BotConnectorRow
      connector={{ id: 'github', Icon: GitHubIcon }}
      name={title ?? 'GitHub'}
      description={face.description}
      status={
        face.status ??
        (ghHost ? { label: ghSignedOutStatus(ghHost), tone: 'warning', listOnly: true } : null)
      }
      lead={ghHost ? <GhSignedOutLine host={ghHost} /> : null}
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
      addAccount={
        signsIn
          ? {
              label: t('bots.github.connection.addAccount', 'Add another GitHub account'),
              onClick: () => addGitHubAccount(bot)
            }
          : null
      }
      update={
        signsIn
          ? {
              label: t('bots.github.connection.refresh', 'Refresh'),
              onClick: () => addGitHubAccount(bot)
            }
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
