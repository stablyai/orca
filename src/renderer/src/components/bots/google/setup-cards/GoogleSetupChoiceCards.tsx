// The setup's choice cards: how to do it, which Google account, which services. A click records the
// answer and tells the bot without a chat message; the card locks and shows a receipt instead.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { NativeChatCardActions } from '@/components/native-chat/NativeChatCardFrame'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotRef } from '@/lib/bot-hosts'
import {
  GOOGLE_SETUP_MODES,
  type GoogleSetupCard,
  type GoogleSetupRun
} from '../../../../../../shared/google/google-setup-run'
import type { GoogleServiceChoice } from '../../../../../../shared/google/google-scopes'
import {
  googleSetupAnsweredServices,
  googleSetupChoiceChangeable
} from '../../../../../../shared/google/google-setup-card-view'
import { importGoogleApp } from '../google-connect-client'
import { GoogleServicePicker } from '../GoogleServicePicker'
import { useGoogleClientFile } from '../use-google-client-file'
import {
  GoogleSetupCardFrame,
  GoogleSetupChoiceRow,
  GoogleSetupReceipt
} from './GoogleSetupCardParts'
import {
  googleSetupPathNote,
  googleSetupOwnerStep,
  googleSetupPathTitle,
  googleSetupReceiptChose,
  googleSetupServicesList
} from './google-setup-card-copy'
import { answerGoogleSetup } from './google-setup-run-store'

function useAnswer(bot: BotRef, card: GoogleSetupCard) {
  const [reopened, setReopened] = useState(false)
  const [busy, setBusy] = useState(false)
  const answer = async (values: string[]): Promise<void> => {
    setBusy(true)
    try {
      await answerGoogleSetup(bot, card, values)
      setReopened(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return { reopened, reopen: () => setReopened(true), busy, answer }
}

const HEADING = (): string => translate('bots.googleSetup.heading', 'Connect Google')

export function GoogleSetupPathCard({
  bot,
  botName,
  run
}: {
  bot: BotRef
  botName: string
  run: GoogleSetupRun
}): React.JSX.Element {
  const t = useTranslate()
  const { reopened, reopen, busy, answer } = useAnswer(bot, 'path')
  const answered = run.answers.path?.values[0]
  const chosen = GOOGLE_SETUP_MODES.find((mode) => mode === answered)
  const locked = answered !== undefined && !reopened
  const file = useGoogleClientFile(async (text) => {
    await importGoogleApp(botTarget(bot), text)
    await answer(['import'])
  })
  const receipt = (): string => {
    if (answered === 'not-now') {
      return t('bots.googleSetup.receipt.dismissed', '✓ Dismissed')
    }
    if (answered === 'import') {
      return t('bots.googleSetup.receipt.imported', '✓ You added your team’s file')
    }
    return googleSetupReceiptChose(chosen ? googleSetupPathTitle(chosen) : (answered ?? ''))
  }
  return (
    <div>
      <GoogleSetupCardFrame
        heading={HEADING()}
        trailing={googleSetupOwnerStep(1)}
        title={t('bots.googleSetup.path.title', 'How should we set it up?')}
        footer={
          locked ? undefined : (
            <NativeChatCardActions
              start={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={file.busy || busy}
                  onClick={() => void file.pick()}
                >
                  {t('bots.googleSetup.importSetupFile', 'Import setup file')}
                </Button>
              }
            >
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void answer(['not-now'])}
              >
                {t('bots.googleSetup.notNow', 'Not now')}
              </Button>
            </NativeChatCardActions>
          )
        }
      >
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(
            'bots.googleSetup.path.why',
            'You create your own Google app, so your sign-in stays on your computer.'
          )}
        </p>
        <div className="mt-2 space-y-2">
          {GOOGLE_SETUP_MODES.map((mode) => (
            <GoogleSetupChoiceRow
              key={mode}
              title={googleSetupPathTitle(mode)}
              note={googleSetupPathNote(mode, botName)}
              chosen={locked && chosen === mode}
              locked={locked || busy}
              onChoose={() => void answer([mode])}
            />
          ))}
        </div>
        {!locked && file.error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {file.error}
          </p>
        ) : null}
      </GoogleSetupCardFrame>
      {locked ? (
        <GoogleSetupReceipt
          text={receipt()}
          onChange={googleSetupChoiceChangeable(run) ? reopen : undefined}
        />
      ) : null}
    </div>
  )
}

export function GoogleSetupAccountCard({
  bot,
  accounts,
  run
}: {
  bot: BotRef
  accounts: readonly string[]
  run: GoogleSetupRun
}): React.JSX.Element {
  const t = useTranslate()
  const { reopened, reopen, busy, answer } = useAnswer(bot, 'account')
  const answered = run.answers.account?.values[0]
  const locked = answered !== undefined && !reopened
  return (
    <div>
      <GoogleSetupCardFrame heading={t('bots.googleSetup.progress.heading', 'Setting up Google')}>
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {t('bots.googleSetup.account.title', 'Which Google account should I use?')}
        </div>
        <div className="mt-2 space-y-2">
          {accounts.map((email) => (
            <GoogleSetupChoiceRow
              key={email}
              title={email}
              note={
                /@(gmail|googlemail)\.com$/i.test(email)
                  ? t('bots.googleSetup.account.personal', 'Personal account')
                  : t('bots.googleSetup.account.work', 'Work account')
              }
              leading={
                <span
                  aria-hidden
                  className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-2xs font-medium text-muted-foreground uppercase"
                >
                  {email.charAt(0)}
                </span>
              }
              chosen={locked && answered === email}
              locked={locked || busy}
              onChoose={() => void answer([email])}
            />
          ))}
        </div>
        <p className="mt-2 text-2xs text-muted-foreground">
          {t(
            'bots.googleSetup.account.note',
            'Every Google Cloud page opens as the account you pick.'
          )}
        </p>
      </GoogleSetupCardFrame>
      {locked && answered ? (
        <GoogleSetupReceipt
          text={googleSetupReceiptChose(answered)}
          onChange={googleSetupChoiceChangeable(run) ? reopen : undefined}
        />
      ) : null}
    </div>
  )
}

export function GoogleSetupServicesCard({
  bot,
  run
}: {
  bot: BotRef
  run: GoogleSetupRun
}): React.JSX.Element {
  const t = useTranslate()
  const { reopened, reopen, busy, answer } = useAnswer(bot, 'services')
  const answered = googleSetupAnsweredServices(run)
  const locked = answered !== null && !reopened
  const [picked, setPicked] = useState<GoogleServiceChoice[]>(answered ?? ['gmail'])
  const shown = locked && answered ? answered : picked
  return (
    <div>
      <GoogleSetupCardFrame heading={HEADING()} trailing={googleSetupOwnerStep(2)}>
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {t('bots.googleSetup.services.title', 'Which Google services should I use?')}
        </div>
        <fieldset disabled={locked || busy} className="mt-2 disabled:opacity-60">
          <GoogleServicePicker value={shown} onChange={setPicked} />
        </fieldset>
        <p className="mt-2 text-2xs text-muted-foreground">
          {t(
            'bots.googleSetup.services.note',
            'With any of these, I can find people by name. You can add more later.'
          )}
        </p>
        {locked ? null : (
          <div className="mt-2">
            <Button
              size="xs"
              disabled={picked.length === 0 || busy}
              onClick={() => void answer(picked)}
            >
              {t('bots.googleSetup.continue', 'Continue')}
            </Button>
          </div>
        )}
      </GoogleSetupCardFrame>
      {locked && answered ? (
        <GoogleSetupReceipt
          text={googleSetupReceiptChose(googleSetupServicesList(answered))}
          onChange={googleSetupChoiceChangeable(run) ? reopen : undefined}
        />
      ) : null}
    </div>
  )
}
