// The Connect card a bot asks for with `orca bot connectors --offer`: connects in one click, and reads
// Connected however the connector got added, with the action that adds access to it.
import { botTarget } from '@/lib/bot-hosts'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { useBotGitHub } from '@/lib/bot-github-state'
import { slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { connectorDescription } from '../bots/AddConnectorDialog'
import { BotAppBrandLogo } from '../bots/apps/BotAppBrandLogo'
import { BOT_CONNECTORS, connectorAddAccessLabel, connectorAdded } from '../bots/bot-connectors'
import { useConnectorSetup } from '../bots/ConnectorSetupDialogs'
import { useGoogleHost } from '../bots/google/google-connect-client'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../../shared/bot-types'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer,
  type ConnectorOfferSource
} from '../../../../shared/bots/bot-connector-offer'
import { googleBotConnectState } from '../../../../shared/google/google-bot-connect-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { NativeChatCardFrame } from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'
import { OrcaCloudSignInLine } from '../bots/orca-cloud-sign-in'
import { useOrcaCloudSignedOut } from '../bots/orca-cloud-signed-out'

type OfferProps = {
  bot: Bot
  offer: ConnectorOffer & { source: ConnectorOfferSource }
  messageId: string
}

/** The bot's workspaces or orgs for the source, by name, as far as they are known yet. */
function SlackOffer(props: OfferProps): React.JSX.Element {
  const view = useBotSlack(props.bot)
  const names = botSlackApps(props.bot).flatMap((app) => {
    const team = view.status === 'ready' ? slackTeamState(view.slack, app.teamId) : null
    return team?.state === 'installed' && team.teamName ? [team.teamName] : []
  })
  return <OfferCard {...props} names={names} />
}

// Connected only once the bot may use Google and this computer is signed in to it.
function GoogleOffer(props: OfferProps): React.JSX.Element {
  const view = useGoogleHost(botTarget(props.bot))
  const state =
    view.status === 'ready'
      ? googleBotConnectState({
          allowed: props.bot.google === true,
          client: view.google.client,
          accounts: view.google.accounts
        })
      : null
  const connected = state?.allowed === true && state.host === 'connected'
  return <OfferCard {...props} names={[]} connected={connected} />
}

function GitHubOffer(props: OfferProps): React.JSX.Element {
  const view = useBotGitHub(props.bot.hostId)
  const removed = props.bot.github?.removedInstallationIds ?? []
  const names =
    props.bot.github && view.status === 'ready'
      ? view.github.installations
          .filter((entry) => !removed.includes(entry.installationId))
          .map((entry) => entry.accountLogin)
      : []
  return <OfferCard {...props} names={names} />
}

// How the bot can work there without the connector: as its owner.
function offerFootnote(source: ConnectorOfferSource): string | null {
  switch (source) {
    case 'github':
      return translate(
        'components.native-chat.connectorOffer.githubAsYou',
        'It can also work in GitHub as you, through your gh login.'
      )
    case 'linear':
      return translate(
        'components.native-chat.connectorOffer.linearAsYou',
        'It can also work in Linear as you, through your own Linear sign-in in Orca.'
      )
    case 'slack':
    case 'google':
      return null
  }
}

function OfferCard({
  bot,
  offer,
  messageId,
  names,
  connected: connectedOverride
}: OfferProps & { names: readonly string[]; connected?: boolean }): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const answering = useNativeChatOffer(bot.id, messageId)
  const setup = useConnectorSetup(bot)
  const connector = BOT_CONNECTORS.find((entry) => entry.id === offer.source)
  const wanted = offer.workspace?.toLowerCase()
  const connected =
    connectedOverride ??
    (wanted
      ? names.some((name) => name.toLowerCase() === wanted)
      : connectorAdded(bot, offer.source))
  const label = connector?.label ?? offer.source
  const heading = connected
    ? t('components.native-chat.connectorOffer.connected', 'Connected')
    : t('components.native-chat.connectorOffer.connect', 'Connect')
  const footnote = offerFootnote(offer.source)
  const addsWorkspace = offer.workspace !== undefined && connectorAdded(bot, offer.source)
  return (
    <NativeChatCardFrame
      avatar={
        <span className="mt-0.5">
          <BotAppBrandLogo app={connector ?? { id: offer.source }} />
        </span>
      }
      heading={heading}
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {offer.workspace ? `${label} · ${offer.workspace}` : label}
          </p>
          {connected ? (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3" aria-hidden />
              {names.length > 0
                ? t(
                    'components.native-chat.connectorOffer.connectedIn',
                    'Connected in {{places}}',
                    {
                      places: names.join(', ')
                    }
                  )
                : t('components.native-chat.connectorOffer.connected', 'Connected')}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{connectorDescription(offer.source)}</p>
              {footnote ? <p className="mt-1 text-2xs text-muted-foreground">{footnote}</p> : null}
            </>
          )}
        </div>
        <NativeChatOfferActions offer={answering} done={connected}>
          <Button type="button" size="xs" onClick={() => setup.start(offer.source)}>
            {addsWorkspace
              ? offer.source === 'github'
                ? t('components.native-chat.connectorOffer.addOrg', 'Add org')
                : t('components.native-chat.connectorOffer.addWorkspace', 'Add workspace')
              : t('components.native-chat.connectorOffer.connect', 'Connect')}
          </Button>
        </NativeChatOfferActions>
      </div>
      {connected && offer.source !== 'google' ? (
        // Connected still adds access: GitHub repositories or organizations, or another workspace.
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mt-2"
          onClick={() => setup.start(offer.source)}
        >
          {connectorAddAccessLabel(offer.source)}
        </Button>
      ) : null}
      {setup.dialogs}
    </NativeChatCardFrame>
  )
}

/** Signed out of Orca: one line with Sign in, which tells the bot once signed in so it saves what it held. */
function SignInOffer({
  bot,
  offer,
  messageId
}: {
  bot: Bot
  offer: ConnectorOffer
  messageId: string
}): React.JSX.Element {
  const t = useTranslate()
  const answering = useNativeChatOffer(bot.id, messageId)
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  const tellBot = (): void =>
    answering.send(t('bots.cloudSignIn.toldBot', 'I’m signed in to Orca now.'), [])
  if (!signedOut || answering.sent) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <p className="flex min-w-0 flex-1 items-center gap-1">
          <Check className="size-3" aria-hidden />
          {t('bots.cloudSignIn.signedIn', 'Signed in to Orca')}
        </p>
        {answering.sent ? null : (
          <Button type="button" variant="outline" size="xs" onClick={tellBot}>
            {t('bots.cloudSignIn.continue', 'Continue')}
          </Button>
        )}
      </div>
    )
  }
  return (
    <OrcaCloudSignInLine
      text={
        offer.source === 'webhook'
          ? t(
              'bots.cloudSignIn.webhooksChat',
              'Webhooks need Orca sign-in. I’ll make it once you’re in.'
            )
          : t(
              'bots.cloudSignIn.eventsChat',
              '{{source}} events need Orca sign-in. I’ll save this rule once you’re in.',
              { source: CONNECTOR_OFFER_NAMES[offer.source] }
            )
      }
      onSignedIn={tellBot}
    />
  )
}

export function NativeChatConnectorOfferCard({
  offer,
  messageId,
  fallback
}: {
  offer: ConnectorOffer
  messageId: string
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}): React.JSX.Element {
  const bot = useBots().find((entry) => entry.id === offer.botId)
  if (!bot) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  if (offer.signIn || offer.source === 'webhook') {
    // Sign in here signs in only this desktop; another host's bot keeps the host's own line.
    return bot.hostId === LOCAL_EXECUTION_HOST_ID ? (
      <SignInOffer bot={bot} offer={offer} messageId={messageId} />
    ) : (
      <p className="text-sm text-chat-foreground-faint">{fallback}</p>
    )
  }
  const props = { bot, offer: { ...offer, source: offer.source }, messageId }
  switch (offer.source) {
    case 'slack':
      return <SlackOffer {...props} />
    case 'github':
      return <GitHubOffer {...props} />
    case 'google':
      return <GoogleOffer {...props} />
    case 'linear':
      return (
        <OfferCard
          {...props}
          names={botLinearWorkspaces(bot).map((entry) => entry.workspaceName)}
        />
      )
  }
}
