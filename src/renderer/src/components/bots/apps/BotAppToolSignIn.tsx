// A catalog or by-URL tool's sign-in, as the Add step shows it: under way, or not finished.
import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { Bot } from '../../../../../shared/bot-types'
import { BotToolFinishSignIn } from '../BotToolFinishSignIn'
import { updateLine } from '../bot-tool-sign-in-action'
import {
  openBotToolSignInPage,
  removeBotTool,
  botToolErrorMessage,
  useBotToolHostSignIn,
  useBotToolSignIn
} from '../bot-tools-client'
import {
  BotAppBrowserWait,
  BotAppOutcome,
  BotAppStepHeader,
  BotAppStepHeading
} from './BotAppStepParts'
import type { CustomPhase } from './BotAppUrlStep'

const FORM_BODY = 'px-6 pt-1 pb-6'

/** A sign-in that didn't finish: why, as this window last heard it, with Try again or Remove. */
export function ToolSignInFailed({
  bot,
  phase,
  logo,
  app,
  onRetry,
  onError,
  onClose
}: {
  bot: Bot
  phase: Extract<CustomPhase, { kind: 'failed' }>
  logo: React.ReactNode
  app: string
  onRetry: () => void
  onError: (error: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const signIn = useBotToolSignIn(bot, phase.name)
  const failure = phase.owned ? signIn.failure : undefined
  const unsupported = failure === 'unsupported'
  const title = unsupported
    ? t('bots.apps.unsupported', 'This app isn’t supported yet')
    : failure === 'needs-update'
      ? updateLine(t, signIn.hostName)
      : failure === 'unavailable'
        ? t('bots.apps.cantReach', 'Can’t reach {{app}}', { app })
        : t('bots.apps.couldNotSignIn', 'Couldn’t sign in to {{app}}', { app })
  const line =
    failure === 'denied'
      ? t('bots.apps.accessNotAllowed', 'Access wasn’t allowed.')
      : failure === 'expired'
        ? t('bots.apps.signInExpired', 'The sign-in expired.')
        : unsupported || failure === 'unavailable' || failure === 'needs-update'
          ? null
          : (phase.error ??
            t(
              'bots.apps.custom.failedLine',
              '{{app}} is on {{bot}} but not signed in. Try again, or remove it in Settings › Tools.',
              { app, bot: bot.name }
            ))
  return (
    <>
      <BotAppStepHeader onClose={onClose} />
      <BotAppOutcome
        logo={logo}
        badge="failed"
        title={title}
        line={line}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('bots.apps.close', 'Close')}
            </Button>
            {unsupported ? (
              <Button
                size="sm"
                onClick={() =>
                  void removeBotTool(bot, phase.name).then(onClose, (error: unknown) =>
                    onError(botToolErrorMessage(error))
                  )
                }
              >
                {t('bots.toolApp.removeNamed', 'Remove {{app}}', { app })}
              </Button>
            ) : (
              <Button size="sm" onClick={onRetry}>
                {t('bots.composio.tryAgain', 'Try again')}
              </Button>
            )}
          </>
        }
      />
    </>
  )
}

/** A tool's sign-in under way: Finish in your browser, or the address pasted from another computer. */
export function ToolSignIn({
  bot,
  phase,
  logo,
  title,
  onPaste,
  onOpenAgain,
  onEnded,
  onClose
}: {
  bot: Bot
  phase: Extract<CustomPhase, { kind: 'signing' }>
  logo: React.ReactNode
  title: string
  onPaste: (paste: boolean) => void
  /** Orca's own sign-in: a fresh one, since its page can't be opened twice. */
  onOpenAgain?: () => void
  onEnded: (outcome: string | undefined) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { active, outcome } = useBotToolSignIn(bot, phase.name)
  // A sign-in the bot's host runs for this device: its page is open here; its address comes back by paste.
  const host = useBotToolHostSignIn(bot, phase.name)
  const hosted = active ? host : null
  // The watch ends with the host's last word on the sign-in.
  React.useEffect(() => {
    if (!active && outcome !== undefined) {
      onEnded(outcome)
    }
  }, [active, outcome, onEnded])
  if (phase.paste) {
    return (
      <>
        <BotAppStepHeader
          backLabel={t('bots.apps.back', 'Back')}
          onBack={() => onPaste(false)}
          onClose={onClose}
        />
        <div className={FORM_BODY}>
          <BotAppStepHeading
            logo={logo}
            title={t('bots.apps.paste.title', 'Signing in on another computer?')}
            line={t(
              'bots.apps.paste.line',
              'Sign in to {{app}} there, then copy the address of the page that didn’t load.',
              { app: title }
            )}
          />
          <BotToolFinishSignIn bot={bot} name={phase.name} />
        </div>
      </>
    )
  }
  const hostedUrl = hosted?.paste ? hosted.url : null
  return (
    <>
      <BotAppStepHeader onClose={onClose} />
      <BotAppBrowserWait
        logo={logo}
        line={
          hosted?.state === 'finishing'
            ? t('bots.toolApp.finishing', 'Finishing sign-in…')
            : t('bots.apps.signInAllow', 'Sign in to {{app}} and allow access.', {
                app: title
              })
        }
        onClose={onClose}
        onOpenAgain={
          hostedUrl
            ? () => openBotToolSignInPage(hostedUrl)
            : (onOpenAgain ??
              (phase.url
                ? () => openBotHostPageOrSay(bot.hostId, phase.url ?? '', { bot, local: 'system' })
                : undefined))
        }
        footer={
          hostedUrl ? (
            <BotToolFinishSignIn bot={bot} name={phase.name} />
          ) : phase.owned ? null : (
            <Button variant="link" size="inlineText" onClick={() => onPaste(true)}>
              {t('bots.apps.paste.remoteSignIn', 'Remote sign-in')}
            </Button>
          )
        }
      />
    </>
  )
}
