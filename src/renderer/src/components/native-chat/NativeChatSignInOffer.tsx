// The Sign in card a bot asks for with `orca bot connectors --offer <source> --sign-in` (and a webhook
// offer): this computer's own sign-in, or a paired server's, and Continue once the bot's events can
// reach it.
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { refreshBotHost, useBotHostConnectorStatus } from '@/lib/bot-catalog'
import { readBotHostConnectorStatus } from '@/lib/bot-catalog-snapshot'
import {
  botHostLinkReadMark,
  botHostLinkReadSince,
  useBotHostLinkReadSinceOpen
} from '@/lib/bot-host-link-read'
import { useBotHostVerified } from '@/lib/bot-host-status'
import {
  useBotHostOrcaAccountReading,
  useBotHostOrcaAccountSettled
} from '@/lib/bot-host-orca-account'
import { useBotHostOffline } from '@/lib/bot-host-views'
import type { Bot } from '../../../../shared/bot-types'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer
} from '../../../../shared/bots/bot-connector-offer'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { OrcaCloudSignInLine } from '../bots/orca-cloud-sign-in'
import { readOrcaCloudSignedOut, useOrcaCloudNeedsSignIn } from '../bots/orca-cloud-signed-out'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'
import { BotConnectorsHostNotice, useServerNoticeState } from '../bots/BotConnectorsHostNotice'
import { useBotHostLabel } from '../bots/use-bot-host-label'
import { useNativeChatOffer } from './NativeChatOfferActions'

type SignInOfferProps = { bot: Bot; offer: ConnectorOffer; messageId: string }

// Why the bot asks: what waits on this computer's sign-in.
function signInReason(offer: ConnectorOffer, t: Translate): string {
  return offer.source === 'webhook'
    ? t(
        'bots.cloudSignIn.webhooksChat',
        'Webhooks need Orca Cloud sign-in. I’ll make it once you’re in.'
      )
    : t(
        'bots.cloudSignIn.eventsChat',
        '{{source}} events need Orca Cloud sign-in. I’ll save this rule once you’re in.',
        { source: CONNECTOR_OFFER_NAMES[offer.source] }
      )
}

/** The bot's host is signed in: Continue tells the bot, which then saves what it held. */
function SignedInRow({
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
  answering.send(translate('bots.cloudSignIn.toldBot', 'I’m signed in to Orca Cloud now.'), [])
}

// This computer's sign-in as far as its link goes: who, and whether signed in. A change starts the
// link's count again, so nothing acts on a read from before it.
function localSignInKey(state: { orcaProfileAuthStatus: OrcaProfileAuthStatus | null }): string {
  const status = state.orcaProfileAuthStatus
  return `${status?.state ?? ''}|${status?.cloud?.userId ?? ''}`
}

function useLocalSignInKey(): string {
  return useAppStore(localSignInKey)
}

async function tellOnceLinked(
  openedAt: number,
  answering: ReturnType<typeof useNativeChatOffer>
): Promise<void> {
  let signInChanged = false
  const stopWatching = useAppStore.subscribe((state, previous) => {
    if (localSignInKey(state) !== localSignInKey(previous)) {
      signInChanged = true
    }
  })
  const mark = Math.max(botHostLinkReadMark(), openedAt)
  try {
    await refreshBotHost(LOCAL_EXECUTION_HOST_ID)
    if (
      !signInChanged &&
      !readOrcaCloudSignedOut() &&
      botHostLinkReadSince(LOCAL_EXECUTION_HOST_ID, mark) &&
      readBotHostConnectorStatus(LOCAL_EXECUTION_HOST_ID) === 'ok'
    ) {
      tellBot(answering)
    }
  } finally {
    stopWatching()
  }
}

/**
 * This computer's Sign in card. Signed out of Orca Cloud: one line with Sign in, which tells the bot once
 * this computer's link reads ok. Continue shows only once a read since the card opened, and since this
 * computer's sign-in last changed, says the link is ok; the automatic reply needs the same.
 */
export function SignInOffer({ bot, offer, messageId }: SignInOfferProps): React.JSX.Element {
  const t = useTranslate()
  const answering = useNativeChatOffer(bot.id, messageId)
  // Signed in only while Orca Cloud takes this computer's sign-in, not merely while it has one.
  const needsSignIn = useOrcaCloudNeedsSignIn()
  const link = useBotHostLinkReadSinceOpen(
    LOCAL_EXECUTION_HOST_ID,
    refreshBotHost,
    useLocalSignInKey()
  )
  const connector = useBotHostConnectorStatus(LOCAL_EXECUTION_HOST_ID)
  if (needsSignIn) {
    return (
      <OrcaCloudSignInLine
        text={signInReason(offer, t)}
        onSignedIn={() => tellOnceLinked(link.mark, answering)}
      />
    )
  }
  if (link.fresh && connector === 'ok') {
    return <SignedInRow answering={answering} />
  }
  // Signed in, but the link is down (refused, or can't reach Orca Cloud): nothing to tell the bot yet.
  if (link.fresh && (connector === 'refused' || connector === 'unreachable')) {
    return (
      <p className="text-xs text-muted-foreground">
        {offer.source === 'webhook'
          ? t(
              'bots.cloudSignIn.webhooksNotReaching',
              'Orca Cloud isn’t reaching {{name}}, so it can’t make webhooks yet.',
              { name: bot.name }
            )
          : notReaching(bot.name, t)}
      </p>
    )
  }
  // Not read since the card opened, or no link at all: why the bot asked, with nothing to press.
  return <p className="text-xs text-muted-foreground">{signInReason(offer, t)}</p>
}

export function notReaching(name: string, t: Translate): string {
  return t('bots.host.notice.notReaching', 'Slack, Linear and GitHub aren’t reaching {{name}}.', {
    name
  })
}

// Why the bot asks, for a server: its own sign-in, which the owner starts from here.
function serverSignInReason(offer: ConnectorOffer, host: string, t: Translate): string {
  return offer.source === 'webhook'
    ? t(
        'bots.cloudSignIn.webhooksHostChat',
        'Webhooks need {{host}} signed in to Orca Cloud. I’ll make it once it is.',
        { host }
      )
    : t(
        'bots.cloudSignIn.eventsHostChat',
        '{{source}} events need {{host}} signed in to Orca Cloud. I’ll save this rule once it is.',
        { source: CONNECTOR_OFFER_NAMES[offer.source], host }
      )
}

/**
 * A server bot's Sign in card: the server's own sign-in, never this desktop's. Signed in only once the
 * verified server says so and its link to Orca Cloud takes it; a server whose state isn't known yet
 * keeps its own line.
 */
export function ServerSignInOffer({
  bot,
  offer,
  messageId,
  fallback
}: SignInOfferProps & { fallback: string }): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  const verified = useBotHostVerified(bot.hostId)
  const settled = useBotHostOrcaAccountSettled(bot.hostId)
  const { state, account, connector } = useServerNoticeState(bot.hostId, bot)
  const answering = useNativeChatOffer(bot.id, messageId)
  const offline = useBotHostOffline(bot.hostId)
  const reading = useBotHostOrcaAccountReading(bot.hostId)
  const linkRead = useBotHostLinkReadSinceOpen(bot.hostId, refreshBotHost).fresh
  // Only positive proof, read now: a live, verified server signed in, and its link to Orca Cloud read
  // since this card opened and saying ok. Having told the bot once proves nothing about it since.
  const ready =
    verified &&
    settled &&
    !reading &&
    linkRead &&
    !offline &&
    state === null &&
    account?.state === 'signed-in' &&
    connector === 'ok'
  if (host && ready) {
    return <SignedInRow answering={answering} />
  }
  if (host && state) {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{serverSignInReason(offer, host, t)}</p>
        <BotConnectorsHostNotice bot={bot} />
      </div>
    )
  }
  return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
}
