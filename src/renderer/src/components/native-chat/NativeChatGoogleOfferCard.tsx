// The Google Connect card: with an account already on the bot's host, use it (the host's default) or
// use another account, through Google's account chooser or a new Google app set up in this chat.
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget } from '@/lib/bot-hosts'
import { connectorDescription } from '../bots/AddConnectorDialog'
import { BotAppBrandLogo } from '../bots/apps/BotAppBrandLogo'
import { BOT_CONNECTORS } from '../bots/bot-connectors'
import { useConnectorSetup } from '../bots/ConnectorSetupDialogs'
import { refreshGoogle, useGoogleHost } from '../bots/google/google-connect-client'
import { googleSignInChoices } from '../bots/google/google-account-readiness'
import { GoogleSignInWaiting } from '../bots/google/GoogleSignInWaiting'
import { GoogleSignInFailed } from '../bots/google/GoogleSignInTrouble'
import { GoogleUseAnotherAccountMenu } from '../bots/google/GoogleUseAnotherAccountMenu'
import { startGoogleSetupInChat } from '../bots/google/setup-cards/google-setup-run-store'
import { useGoogleSignIn } from '../bots/google/use-google-sign-in'
import { useTurnOnBotGoogle } from '../bots/google/use-turn-on-bot-google'
import type { Bot } from '../../../../shared/bot-types'
import {
  NativeChatCardActions,
  NativeChatCardFrame,
  NativeChatCardStatus
} from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'
import { googleOfferFace, googleOfferSignedInAnswer } from './google-offer-face'

export function NativeChatGoogleOfferCard({
  bot,
  messageId
}: {
  bot: Bot
  messageId: string
}): React.JSX.Element {
  const t = useTranslate()
  const answering = useNativeChatOffer(bot.id, messageId)
  const setup = useConnectorSetup(bot)
  const turnOnGoogle = useTurnOnBotGoogle()
  const signIn = useGoogleSignIn(botTarget(bot), bot)
  const view = useGoogleHost(botTarget(bot))
  const google = view.status === 'ready' ? view.google : null
  const face = google ? googleOfferFace(google, bot.google === true) : { kind: 'connect' as const }
  const defaultAccount = face.kind === 'connect' ? null : face.defaultAccount
  const fallback = google?.accounts.find((account) => account.email === defaultAccount)
  const choices = googleSignInChoices(fallback)
  // The account this card connected, when it isn't the default; the bot is told to name it.
  const added = answering.sent?.[0] ?? null
  const shown = added ?? defaultAccount

  const signInThenTurnOn = async (account?: string): Promise<void> => {
    const connected = await signIn.connect(choices, account)
    if (!connected || (bot.google !== true && !(await turnOnGoogle(bot)))) {
      return
    }
    const text = t('components.native-chat.googleOffer.useAccount', 'Use {{email}} for Google.', {
      email: connected.email
    })
    // The sign-in can take minutes; compare with the default as it is now, not at the click.
    const latest = await refreshGoogle(botTarget(bot))
    const answer = googleOfferSignedInAnswer(connected.email, {
      added,
      defaultAccount: latest.status === 'ready' ? (latest.google.defaultAccount ?? null) : null
    })
    if (answer === 'again') {
      answering.sendAgain(text, [connected.email])
    } else if (answer === 'send') {
      answering.send(text, [connected.email])
    }
  }

  const newApp = (): void => {
    if (signIn.state.kind !== 'idle') {
      signIn.cancel()
    }
    void startGoogleSetupInChat(bot, 'chat', { newApp: true }).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    )
  }

  const waiting = signIn.state.kind === 'waiting'
  const footer = waiting ? undefined : face.kind === 'connected' ? (
    face.canAdd ? (
      <NativeChatCardActions>
        <GoogleUseAnotherAccountMenu onSignIn={() => void signInThenTurnOn()} onNewApp={newApp} />
      </NativeChatCardActions>
    ) : undefined
  ) : face.kind === 'choose' ? (
    <NativeChatOfferActions
      offer={answering}
      start={
        <GoogleUseAnotherAccountMenu
          variant="ghost"
          onSignIn={() => void signInThenTurnOn()}
          onNewApp={newApp}
        />
      }
    >
      {face.reconnect ? (
        <Button type="button" size="sm" onClick={() => void signInThenTurnOn(face.defaultAccount)}>
          {t('components.native-chat.googleOffer.reconnect', 'Reconnect {{email}}', {
            email: face.defaultAccount
          })}
        </Button>
      ) : (
        <Button type="button" size="sm" onClick={() => setup.start('google')}>
          {t('components.native-chat.googleOffer.use', 'Use {{email}}', {
            email: face.defaultAccount
          })}
        </Button>
      )}
    </NativeChatOfferActions>
  ) : (
    <NativeChatOfferActions offer={answering}>
      <Button type="button" size="sm" onClick={() => setup.start('google')}>
        {t('components.native-chat.connectorOffer.connectService', 'Connect {{service}}', {
          service: 'Google'
        })}
      </Button>
    </NativeChatOfferActions>
  )
  const connector = BOT_CONNECTORS.find((entry) => entry.id === 'google')
  const label = connector?.label
  return (
    <NativeChatCardFrame
      avatar={
        <span className="mt-0.5">
          <BotAppBrandLogo app={connector ?? { id: 'google' }} />
        </span>
      }
      heading={t('components.native-chat.connectorOffer.heading', 'Connect a service')}
      status={
        face.kind === 'connected' ? (
          <NativeChatCardStatus tone="success">
            {t('components.native-chat.connectorOffer.connected', 'Connected')}
          </NativeChatCardStatus>
        ) : null
      }
      title={
        face.kind === 'connected' && shown
          ? t('bots.google.account', 'Google · {{email}}', { email: shown })
          : label
      }
      footer={footer}
    >
      {face.kind === 'connected' ? (
        added && defaultAccount && added !== defaultAccount ? (
          <p className="text-xs text-muted-foreground">
            {t('components.native-chat.googleOffer.staysDefault', '{{email}} stays the default', {
              email: defaultAccount
            })}
          </p>
        ) : null
      ) : (
        <p className="mt-0.5">{connectorDescription('google')}</p>
      )}
      {signIn.state.kind === 'waiting' ? (
        <div className="mt-2">
          <GoogleSignInWaiting state={signIn.state} onCancel={signIn.cancel} onNewApp={newApp} />
        </div>
      ) : signIn.state.kind === 'failed' ? (
        <GoogleSignInFailed className="mt-0.5" error={signIn.state.error} onNewApp={newApp} />
      ) : null}
      {setup.dialogs}
    </NativeChatCardFrame>
  )
}
