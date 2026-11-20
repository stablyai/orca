// A Composio setup card in a bot's chat, drawn from the host's Composio state (the key and the bot's
// sign-ins) rather than from the item, so every client shows it the same and it locks as things change.
import type { Bot } from '../../../../../shared/bot-types'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import React, { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  NativeChatCardAvatar,
  NativeChatCardFrame
} from '@/components/native-chat/NativeChatCardFrame'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { botToolErrorMessage } from '../bot-tools-client'
import {
  COMPOSIO_PAGES,
  type ComposioAppSignIn
} from '../../../../../shared/composio/composio-apps'
import type { ComposioSetupCardRef } from '../../../../../shared/composio/composio-setup-card'
import { GoogleSetupReceipt } from '../google/setup-cards/GoogleSetupCardParts'
import { ComposioAppLogo } from './ComposioAppLogo'
import { ComposioEventsCard } from './ComposioEventsCard'
import { ComposioAppSetUpSteps } from './ComposioAppSetUpSteps'
import { ComposioKeyForm } from './ComposioKeyForm'
import {
  cancelComposioConnect,
  connectComposioApp,
  declineComposioKey,
  openBotToolsSettings,
  openComposioPage,
  readComposioApp,
  useComposioBot
} from './composio-client'

const COMPOSIO = (): string => translate('bots.composio.card.heading', 'Composio')

function stepLabel(step: ComposioSetupCardRef['step']): string | null {
  return step
    ? translate('bots.composio.card.step', 'Step {{index}} of {{total}}', {
        index: step.index,
        total: step.total
      })
    : null
}

function KeyCard({ card, bot }: { card: ComposioSetupCardRef; bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const view = useComposioBot(bot)
  const [changing, setChanging] = useState(false)
  const [declined, setDeclined] = useState(false)
  const added = view.status?.key === 'ok'
  const rejected = view.status?.key === 'rejected'
  const asking = (!added && !declined) || changing
  return (
    <div>
      <NativeChatCardFrame
        avatar={
          <NativeChatCardAvatar>
            <KeyRound className="size-4 text-muted-foreground" />
          </NativeChatCardAvatar>
        }
        heading={COMPOSIO()}
        trailing={stepLabel(card.step)}
      >
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {rejected
            ? t('bots.composio.card.keyRejectedTitle', 'Replace your Composio key')
            : t('bots.composio.card.keyTitle', 'Add your Composio key')}
        </div>
        {rejected ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'bots.composio.card.keyRejectedNote',
              'Composio no longer accepts the saved key. Make a new one in Composio under Settings, API Keys.'
            )}
          </p>
        ) : null}
        {asking ? (
          <div className="mt-1.5">
            <ComposioKeyForm
              hostId={bot.hostId}
              from={
                added ? undefined : { botId: card.botId, ...(card.app ? { app: card.app } : {}) }
              }
              replacing={added || rejected}
              onSaved={() => setChanging(false)}
              onCancel={changing ? () => setChanging(false) : undefined}
            />
            {added ? null : (
              <Button
                size="xs"
                variant="ghost"
                className="mt-1"
                onClick={() => {
                  setDeclined(true)
                  void declineComposioKey(bot).catch((error: unknown) => {
                    setDeclined(false)
                    toast.error(botToolErrorMessage(error))
                  })
                }}
              >
                {t('bots.composio.card.dismiss', 'Dismiss')}
              </Button>
            )}
          </div>
        ) : null}
      </NativeChatCardFrame>
      {added && !changing ? (
        <GoogleSetupReceipt
          text={t('bots.composio.card.keyAdded', '✓ Key added')}
          onChange={() => setChanging(true)}
        />
      ) : declined && !added ? (
        <GoogleSetupReceipt
          text={t('bots.composio.card.declined', 'Dismissed')}
          onChange={() => setDeclined(false)}
        />
      ) : null}
    </div>
  )
}

type AppSignInCheck = { signIn: ComposioAppSignIn | null; checking: boolean; again: boolean }

/** How the card's app signs in at Composio now; `check(true)` is the owner's Check again. */
function useAppSignIn(listed: BotRef, slug: string | undefined, keyReady: boolean) {
  const bot = useStableBotRef(listed)
  const [state, setState] = useState<AppSignInCheck>({
    signIn: null,
    checking: false,
    again: false
  })
  const check = useCallback(
    (again: boolean) => {
      if (!slug) {
        return
      }
      setState((before) => ({ ...before, checking: true }))
      void readComposioApp(bot, slug).then(
        (app) => setState({ signIn: app.signIn, checking: false, again }),
        // Unread, the card offers Connect; Composio's answer to it says what's missing.
        () => setState({ signIn: null, checking: false, again })
      )
    },
    [bot, slug]
  )
  useEffect(() => {
    if (keyReady) {
      check(false)
    }
  }, [keyReady, check])
  return { ...state, check }
}

function ConnectCard({
  card,
  bot
}: {
  card: ComposioSetupCardRef
  bot: Bot
}): React.JSX.Element | null {
  const view = useComposioBot(bot)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const app = card.app
  const signIn = useAppSignIn(bot, app?.slug, view.status?.key === 'ok')
  if (!app) {
    return null
  }
  const connected = view.connections?.connections.some(
    (entry) => entry.app === app.slug && entry.status === 'active'
  )
  const pending = view.connections?.pending.find((entry) => entry.app === app.slug)
  const keyMissing = view.status !== null && view.status.key !== 'ok'
  const connect = () => {
    setBusy(true)
    setError(null)
    void connectComposioApp(bot, app.slug, {
      name: app.name,
      ...(card.reason ? { reason: card.reason } : {})
    })
      .catch((caught: unknown) => {
        setError(botToolErrorMessage(caught))
        signIn.check(false)
      })
      .finally(() => setBusy(false))
  }
  const needsSetUp = signIn.signIn === 'own' && !connected && !pending && !keyMissing
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <ComposioAppLogo slug={app.slug} size="sm" />
        </NativeChatCardAvatar>
      }
      heading={COMPOSIO()}
      trailing={stepLabel(card.step)}
    >
      {needsSetUp ? (
        <ComposioAppSetUpSteps
          app={app}
          checking={signIn.checking}
          stillMissing={signIn.again && !signIn.checking}
          onCheckAgain={() => {
            setError(null)
            signIn.check(true)
          }}
        />
      ) : (
        <ConnectBody
          bot={bot}
          app={app}
          connected={connected === true}
          pending={pending}
          keyMissing={keyMissing}
          busy={busy || view.status === null}
          error={error}
          signIn={signIn.signIn}
          onConnect={connect}
        />
      )}
    </NativeChatCardFrame>
  )
}

function ConnectBody({
  bot,
  app,
  connected,
  pending,
  keyMissing,
  busy,
  error,
  signIn,
  onConnect
}: {
  bot: BotRef
  app: { slug: string; name: string }
  connected: boolean
  pending: { url: string } | undefined
  keyMissing: boolean
  busy: boolean
  error: string | null
  signIn: ComposioAppSignIn | null
  onConnect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <div className="mt-0.5 text-sm font-medium text-foreground">
        {t('bots.composio.card.connectTitle', 'Connect {{app}}', { app: app.name })}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {pending
          ? t('bots.composio.connecting', 'Waiting for you to finish signing in, in your browser')
          : signIn === 'key'
            ? t(
                'bots.composio.card.connectKeyNote',
                'Opens Composio to enter your {{app}} API key. Composio keeps it, not Orca.',
                { app: app.name }
              )
            : t(
                'bots.composio.card.connectNote',
                'Opens {{app}}’s sign-in from Composio in your browser. Composio keeps this sign-in, not Orca.',
                { app: app.name }
              )}
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {connected ? null : pending ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => openComposioPage(pending.url)}>
            {t('bots.composio.openAgain', 'Open again')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void cancelComposioConnect(bot, app.slug)}
          >
            {t('bots.composio.cancel', 'Cancel')}
          </Button>
        </div>
      ) : keyMissing ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('bots.composio.card.keyFirst', 'Add your Composio key first.')}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" disabled={busy} onClick={onConnect}>
            {t('bots.composio.card.connect', 'Connect {{app}}', { app: app.name })}
          </Button>
          {error ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openComposioPage(COMPOSIO_PAGES.authConfigs)}
            >
              {t('bots.composio.setUpSteps.openAuthConfigs', 'Open Auth Configs')}
              <ExternalLink />
            </Button>
          ) : null}
        </div>
      )}
    </>
  )
}

function ReadyCard({
  card,
  bot,
  botName
}: {
  card: ComposioSetupCardRef
  bot: BotRef
  botName: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const view = useComposioBot(bot)
  const app = card.app
  if (!app) {
    return null
  }
  const signIns = view.connections?.connections.filter((entry) => entry.app === app.slug) ?? []
  const connection = signIns.find((entry) => entry.status === 'active')
  // The card was true when written; the key, the bot's tool or the sign-in may be gone since.
  const gone =
    view.status !== null &&
    (view.status.key !== 'ok' || !view.status.added || (signIns.length > 0 && !connection))
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <Check className="size-4 text-muted-foreground" />
        </NativeChatCardAvatar>
      }
      heading={
        gone
          ? t('bots.composio.card.goneHeading', 'Needs setup')
          : t('bots.composio.card.ready', 'Ready')
      }
    >
      <div className="mt-0.5 text-sm font-medium text-foreground">
        {gone
          ? t('bots.composio.card.goneTitle', '{{bot}} can’t use {{app}} now', {
              bot: botName,
              app: app.name
            })
          : t('bots.composio.card.readyTitle', '{{bot}} can now use {{app}}', {
              bot: botName,
              app: app.name
            })}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {gone
          ? t('bots.composio.card.goneDetail', 'Set it up again from the bot’s Tools.')
          : connection?.label
            ? t(
                'bots.composio.card.readyAs',
                'As {{label}}. Your app sign-ins are held by Composio.',
                { label: connection.label }
              )
            : t('bots.composio.custody', 'Your app sign-ins are held by Composio.')}
      </p>
      <div className="mt-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openBotToolsSettings(card.botId, { browse: true })}
        >
          {t('bots.composio.card.browse', 'Browse more apps')}
        </Button>
      </div>
    </NativeChatCardFrame>
  )
}

export function ComposioSetupChatCard({
  card,
  fallback
}: {
  card: ComposioSetupCardRef
  /** The host's line, for a bot this window can't read. */
  fallback: string
}): React.JSX.Element {
  useTranslation()
  const bot = useBots().find((entry) => entry.id === card.botId)
  if (!bot) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  switch (card.card) {
    case 'key':
      return <KeyCard card={card} bot={bot} />
    case 'connect':
      return <ConnectCard card={card} bot={bot} />
    case 'ready':
      return <ReadyCard card={card} bot={bot} botName={bot.name} />
    case 'events':
      return <ComposioEventsCard card={card} bot={bot} botName={bot.name} />
  }
}
