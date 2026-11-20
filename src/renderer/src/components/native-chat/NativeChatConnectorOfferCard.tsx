// The Connect card a bot asks for with `orca bot connectors --offer`: connects in one click, and reads
// Connected however the connector got added, with the action that adds access to it.
import { botTarget } from '@/lib/bot-hosts'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBotHostConnectorStatus, useCardBot } from '@/lib/bot-catalog'
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
import {
  NativeChatCardActions,
  NativeChatCardFrame,
  NativeChatCardStatus
} from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'
import { OrcaCloudSignInLine } from '../bots/orca-cloud-sign-in'
import { BotHostSignInControl } from '../bots/BotConnectorsHostNotice'
import { useBotHostLabel } from '../bots/use-bot-host-label'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
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
  const footnote = offerFootnote(offer.source)
  const addsWorkspace = offer.workspace !== undefined && connectorAdded(bot, offer.source)
  const actionLabel = addsWorkspace
    ? offer.source === 'github'
      ? t('components.native-chat.connectorOffer.addOrg', 'Add org')
      : t('components.native-chat.connectorOffer.addWorkspace', 'Add workspace')
    : t('components.native-chat.connectorOffer.connectService', 'Connect {{service}}', {
        service: label
      })
  const footer = connected ? (
    // Connected still adds access: GitHub repositories or organizations, or another workspace.
    offer.source === 'google' ? undefined : (
      <NativeChatCardActions>
        <Button type="button" variant="outline" size="sm" onClick={() => setup.start(offer.source)}>
          {connectorAddAccessLabel(offer.source)}
        </Button>
      </NativeChatCardActions>
    )
  ) : (
    <NativeChatOfferActions offer={answering}>
      <Button type="button" size="sm" onClick={() => setup.start(offer.source)}>
        {actionLabel}
      </Button>
    </NativeChatOfferActions>
  )
  return (
    <NativeChatCardFrame
      avatar={
        <span className="mt-0.5">
          <BotAppBrandLogo app={connector ?? { id: offer.source }} />
        </span>
      }
      heading={t('components.native-chat.connectorOffer.heading', 'Connect a service')}
      status={
        connected ? (
          <NativeChatCardStatus tone="success">
            {t('components.native-chat.connectorOffer.connected', 'Connected')}
          </NativeChatCardStatus>
        ) : null
      }
      title={offer.workspace ? `${label} · ${offer.workspace}` : label}
      footer={footer}
    >
      {connected ? (
        names.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('components.native-chat.connectorOffer.connectedIn', 'Connected in {{places}}', {
              places: names.join(', ')
            })}
          </p>
        ) : null
      ) : (
        <>
          <p className="mt-0.5">{connectorDescription(offer.source)}</p>
          {footnote ? <p className="mt-0.5 text-xs text-muted-foreground">{footnote}</p> : null}
        </>
      )}
      {setup.dialogs}
    </NativeChatCardFrame>
  )
}

type SignInOfferProps = { bot: Bot; offer: ConnectorOffer; messageId: string }

function signInOfferText(offer: ConnectorOffer, t: Translate): string {
  return offer.source === 'webhook'
    ? t('bots.cloudSignIn.webhooksChat', 'Webhooks need Orca sign-in. I’ll make it once you’re in.')
    : t(
        'bots.cloudSignIn.eventsChat',
        '{{source}} events need Orca sign-in. I’ll save this rule once you’re in.',
        { source: CONNECTOR_OFFER_NAMES[offer.source] }
      )
}

/** Signed in: Continue tells the bot, so it saves what it held. */
function SignedInLine({
  answering
}: {
  answering: ReturnType<typeof useNativeChatOffer>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <p className="flex min-w-0 flex-1 items-center gap-1">
        <Check className="size-3" aria-hidden />
        {t('bots.cloudSignIn.signedIn', 'Signed in to Orca')}
      </p>
      {answering.sent ? null : (
        <Button type="button" variant="outline" size="xs" onClick={() => tellBot(answering)}>
          {t('bots.cloudSignIn.continue', 'Continue')}
        </Button>
      )}
    </div>
  )
}

function tellBot(answering: ReturnType<typeof useNativeChatOffer>): void {
  answering.send(translate('bots.cloudSignIn.toldBot', 'I’m signed in to Orca now.'), [])
}

/** This computer signed out of Orca: one line with Sign in, which tells the bot once signed in. */
function SignInOffer({ bot, offer, messageId }: SignInOfferProps): React.JSX.Element {
  const t = useTranslate()
  const answering = useNativeChatOffer(bot.id, messageId)
  const signedOut = useOrcaCloudSignedOut(bot.hostId)
  if (!signedOut || answering.sent) {
    return <SignedInLine answering={answering} />
  }
  return (
    <OrcaCloudSignInLine text={signInOfferText(offer, t)} onSignedIn={() => tellBot(answering)} />
  )
}

/** The server the bot runs on signed out of Orca: Sign in on that server, as its Connectors notice does. */
function ServerSignInOffer(
  props: SignInOfferProps & { host: string; fallback: string }
): React.JSX.Element {
  const answering = useNativeChatOffer(props.bot.id, props.messageId)
  // An answered card reads nothing from the server.
  return answering.sent ? (
    <SignedInLine answering={answering} />
  ) : (
    <ServerSignInAsk {...props} answering={answering} />
  )
}

function ServerSignInAsk({
  bot,
  offer,
  host,
  fallback,
  answering
}: SignInOfferProps & {
  host: string
  fallback: string
  answering: ReturnType<typeof useNativeChatOffer>
}): React.JSX.Element {
  const t = useTranslate()
  const account = useBotHostOrcaAccount(bot.hostId)
  // The host's own fact, as its CLI and the phone read it: events wait while its connector is signed out.
  const connector = useBotHostConnectorStatus(bot.hostId)
  // An Orca that can't say its sign-in, or can't sign in, keeps its own line.
  if (!account || account.state === 'unconfigured') {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  if (
    account.state === 'signed-in' &&
    connector !== 'signed-out' &&
    connector !== 'needs-sign-in'
  ) {
    return <SignedInLine answering={answering} />
  }
  return (
    <div role="status" className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p>{signInOfferText(offer, t)}</p>
      <BotHostSignInControl
        hostId={bot.hostId}
        host={host}
        bot={bot}
        label={
          account.state === 'signed-out'
            ? t('bots.host.signIn.start', 'Sign in on {{host}}', { host })
            : t('bots.host.signIn.again', 'Sign {{host}} in again', { host })
        }
        firstSignIn={account.state === 'signed-out'}
      />
    </div>
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
  const { bot } = useCardBot(offer.botId)
  const host = useBotHostLabel(bot?.hostId ?? LOCAL_EXECUTION_HOST_ID)
  if (!bot) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  if (offer.signIn || offer.source === 'webhook') {
    // The sign-in is the one of the computer the bot runs on; a server this window can't name keeps its line.
    if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
      return <SignInOffer bot={bot} offer={offer} messageId={messageId} />
    }
    return host ? (
      <ServerSignInOffer
        bot={bot}
        offer={offer}
        messageId={messageId}
        host={host}
        fallback={fallback}
      />
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
