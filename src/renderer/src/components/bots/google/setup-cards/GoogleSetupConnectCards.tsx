// The setup's last two cards: the owner's own sign-in with the new app (a bot can't sign in for
// them), then what the bot can use. Turning Google on for the bot asks first when others can ask it.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import {
  googleReadyChoices,
  googleSetupBlockerIsConnect
} from '../../../../../../shared/google/google-setup-card-view'
import { useTurnOnBotGoogle } from '../use-turn-on-bot-google'
import { googleAccountChoices, googleReadinessFixer } from '../GoogleAccountReadiness'
import { googleChoiceLogos, GoogleLogoStack } from '../GoogleServicePicker'
import { GoogleAddServiceDialog } from '../GoogleAddServiceDialog'
import { GoogleSignInWaiting } from '../GoogleSignInWaiting'
import { shareGoogleApp, useGoogleHost } from '../google-connect-client'
import { googleFixLabel, googleReadinessFace, googleReadinessRows } from '../google-copy'
import { useGoogleSignIn } from '../use-google-sign-in'
import { useBotHostLabel } from '../../use-bot-host-label'
import { GoogleSetupCardFrame, GoogleSetupReceipt } from './GoogleSetupCardParts'
import { googleSetupOwnerStep, googleSetupServicesList } from './google-setup-card-copy'
import { GoogleSetupBlockerPanel } from './GoogleSetupBlockerPanel'
import { answerGoogleSetup, useGoogleSetupBlocker } from './google-setup-run-store'

const HEADING = (): string => translate('bots.googleSetup.heading', 'Connect Google')

export function GoogleSetupConnectCard({
  bot,
  run,
  newest
}: {
  bot: Parameters<ReturnType<typeof useTurnOnBotGoogle>>[0]
  run: GoogleSetupRun
  /** Orca writes this card again at the bottom when sign-in waits; an older copy only points there. */
  newest: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const signIn = useGoogleSignIn(botTarget(bot))
  const host = useBotHostLabel(bot.hostId)
  const turnOn = useTurnOnBotGoogle()
  const done = run.steps.connect?.status === 'done'
  const blocker = useGoogleSetupBlocker(bot)
  const stuck = blocker && googleSetupBlockerIsConnect(blocker) ? blocker : null
  const connect = async (): Promise<void> => {
    const account = await signIn.connect(run.services ?? ['gmail'], run.account)
    if (!account) {
      return
    }
    // Declining the confirm still leaves the account connected; the bot hears either way.
    const on = await turnOn(bot)
    await answerGoogleSetup(bot, 'step', ['done', 'connect', ...(on ? [] : ['google-off'])])
  }
  return (
    <div>
      <GoogleSetupCardFrame heading={HEADING()} trailing={googleSetupOwnerStep(3)}>
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {run.account
            ? t('bots.googleSetup.connect.titleAccount', 'Sign in to connect {{email}}', {
                email: run.account
              })
            : t('bots.googleSetup.connect.title', 'Sign in to connect')}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {host
            ? t(
                'bots.googleSetup.connect.noteOnHost',
                'Orca’s browser for {{host}} opens Google’s sign-in. Your Google sign-in stays on {{host}}.',
                { host }
              )
            : t(
                'bots.googleSetup.connect.note',
                'Your browser opens Google’s sign-in. Your Google sign-in stays on this computer.'
              )}
        </p>
        {!done && run.kind !== 'work' ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              'bots.googleSetup.connect.warning',
              'Google will show a warning because this app is yours and brand new. Choose Advanced, then Go to Orca, and tick every box on the next screen.'
            )}
          </p>
        ) : null}
        {/* A failed sign-in says so whichever buttons follow, the blocker's or Sign in. */}
        {signIn.state.kind === 'failed' ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {signIn.state.error}
          </p>
        ) : null}
        {/* An older copy never acts, done or not; it points down while something is left to press. */}
        {!newest ? (
          stuck || !done ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('bots.googleSetup.movedDown', 'Continued further down.')}
            </p>
          ) : null
        ) : signIn.state.kind === 'waiting' ? (
          <div className="mt-2">
            <GoogleSignInWaiting
              state={signIn.state}
              onCancel={signIn.cancel}
              personal={run.kind === 'personal'}
            />
          </div>
        ) : stuck ? (
          <GoogleSetupBlockerPanel bot={bot} run={run} blocker={stuck} signIn={signIn} />
        ) : done ? null : (
          <div className="mt-2">
            <Button size="xs" onClick={() => void connect()}>
              {t('bots.google.signIn', 'Sign in to Google')}
            </Button>
          </div>
        )}
      </GoogleSetupCardFrame>
      {done ? (
        <GoogleSetupReceipt
          text={
            run.account
              ? t('bots.googleSetup.receipt.signedInAs', '✓ Signed in as {{email}}', {
                  email: run.account
                })
              : t('bots.googleSetup.receipt.signedIn', '✓ Signed in')
          }
        />
      ) : null}
    </div>
  )
}

/** What the bot can now use. A service gets a label only when something's wrong with it. */
export function GoogleSetupConnectedCard({
  bot,
  botName,
  run
}: {
  bot: BotRef
  botName: string
  run: GoogleSetupRun
}): React.JSX.Element {
  const t = useTranslate()
  const host = useGoogleHost(botTarget(bot))
  const signIn = useGoogleSignIn(botTarget(bot))
  const google = host.status === 'ready' ? host.google : null
  const account =
    google?.accounts.find((entry) => entry.email === run.account) ?? google?.accounts[0] ?? null
  const rows = account ? googleReadinessRows(account).filter((row) => row.key !== 'contacts') : []
  const ready = account ? googleReadyChoices(account) : (run.services ?? [])
  const fix = account
    ? googleReadinessFixer({
        target: botTarget(bot),
        account,
        clientId: google?.client?.clientId ?? null,
        projectId: google?.client?.projectId ?? null,
        onAllowAgain: (choices) => void signIn.connect(choices, account.email)
      })
    : null
  const problems = rows.filter((row) => row.readiness.state !== 'ready')
  const [adding, setAdding] = useState(false)
  return (
    <GoogleSetupCardFrame heading={t('bots.googleSetup.connected.heading', 'Google connected')}>
      <div className="mt-0.5 text-sm font-medium text-foreground">
        {account?.email ?? run.account}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2.5 text-sm text-foreground">
        {/* Every service set up, with a label beside only the ones that need something. */}
        <GoogleLogoStack logos={googleChoiceLogos(run.services?.length ? run.services : ready)} />
        {ready.length > 0 ? (
          <span>
            {t('bots.googleSetup.connected.canUse', '{{bot}} can use {{services}}.', {
              bot: botName,
              services: googleSetupServicesList(ready)
            })}
          </span>
        ) : null}
        {problems.map((row) => {
          const face = googleReadinessFace(row.readiness)
          return (
            <span key={row.key} className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">{row.label} ·</span>
              {face.fix && fix ? (
                <Button variant="link" size="inlineText" onClick={() => fix(row.readiness)}>
                  {googleFixLabel(face.fix)}
                </Button>
              ) : (
                <span className="text-muted-foreground">{face.label}</span>
              )}
            </span>
          )
        })}
      </div>
      {signIn.state.kind === 'waiting' ? (
        <div className="mt-2">
          <GoogleSignInWaiting state={signIn.state} onCancel={signIn.cancel} />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        {account ? (
          <Button variant="link" size="inlineText" onClick={() => setAdding(true)}>
            {t('bots.googleSetup.connected.add', 'Add a service')}
          </Button>
        ) : null}
        {account && run.kind === 'work' ? <span aria-hidden>·</span> : null}
        {run.kind === 'work' ? (
          <Button
            variant="link"
            size="inlineText"
            onClick={() => shareGoogleApp(botTarget(bot), google?.client?.projectId)}
          >
            {t('bots.googleSetup.connected.share', 'Share setup')}
          </Button>
        ) : null}
      </div>
      {account ? (
        <GoogleAddServiceDialog
          open={adding}
          onOpenChange={setAdding}
          have={googleAccountChoices(account)}
          projectId={google?.client?.projectId}
          account={account.email}
          onSignIn={(services) => {
            setAdding(false)
            void signIn.connect(services, account.email)
          }}
        />
      ) : null}
    </GoogleSetupCardFrame>
  )
}
