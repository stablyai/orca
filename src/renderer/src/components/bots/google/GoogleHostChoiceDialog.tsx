import React, { useId } from 'react'
import { botTarget } from '@/lib/bot-hosts'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { botErrorMessage } from '../bot-presentation'
import { importGoogleApp } from './google-connect-client'
import { answerGoogleSetup, startGoogleSetupInChat } from './setup-cards/google-setup-run-store'
import { useGoogleClientFile } from './use-google-client-file'

type GoogleHostChoiceBot = Pick<Bot, 'id' | 'name'> & Parameters<typeof startGoogleSetupInChat>[0]

function HostOption({
  value,
  disabled,
  title,
  badge,
  children
}: {
  value: string
  disabled?: boolean
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-ring has-disabled:opacity-50">
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label htmlFor={id}>
          {title}
          {badge}
        </Label>
        {children}
      </div>
    </div>
  )
}

function SetupStep({ n, children }: { n: number; children: string }): React.JSX.Element {
  return (
    <li className="flex gap-2 text-xs text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-semibold text-foreground">
        {n}
      </span>
      {children}
    </li>
  )
}

/** Before Google setup starts in chat: Orca hosted is on its way, so for now the owner makes their own app. */
export function GoogleHostChoiceDialog({
  bot,
  open,
  onOpenChange
}: {
  bot: GoogleHostChoiceBot
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const start = (then?: () => Promise<void>): void => {
    onOpenChange(false)
    void startGoogleSetupInChat(bot, 'add-connector')
      .then(then)
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
  }
  // A team's file skips making the app: the chat's setup carries on from it, as its own Import does.
  const file = useGoogleClientFile(async (text) => {
    await importGoogleApp(botTarget(bot), text)
    start(() => answerGoogleSetup(bot, 'path', ['import']))
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent scrollable className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bots.google.connect', 'Connect Google')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.google.hostChoice.description',
              'Choose how {{bot}} signs in to your Gmail, Calendar and Drive.',
              { bot: bot.name }
            )}
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value="self">
          <HostOption
            value="orca"
            disabled
            title={t('bots.google.hostChoice.orca', 'Orca hosted')}
            badge={
              <Badge variant="comingSoon">
                {t('bots.google.hostChoice.comingSoon', 'Coming soon')}
              </Badge>
            }
          >
            <p className="text-xs text-muted-foreground">
              {t('bots.google.hostChoice.orcaNote', 'Sign in with Google. Nothing to set up.')}
            </p>
          </HostOption>
          <HostOption value="self" title={t('bots.google.hostChoice.self', 'Self hosted')}>
            <p className="text-xs text-muted-foreground">
              {t(
                'bots.google.hostChoice.selfNote',
                'You make your own Google Cloud app, so your sign-in stays on your computer. Nothing goes through Orca’s servers.'
              )}
            </p>
            <ol className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
              <SetupStep n={1}>
                {t(
                  'bots.google.hostChoice.stepApp',
                  '{{bot}} opens Google Cloud and sets up the app',
                  { bot: bot.name }
                )}
              </SetupStep>
              <SetupStep n={2}>
                {t('bots.google.hostChoice.stepSignIn', 'You tick Google’s terms box and sign in')}
              </SetupStep>
              <SetupStep n={3}>
                {t(
                  'bots.google.hostChoice.stepCheck',
                  '{{bot}} checks that Gmail, Calendar and Drive work',
                  { bot: bot.name }
                )}
              </SetupStep>
            </ol>
            <Badge variant="secondary" className="mt-2">
              {t('bots.google.setUpTime', 'About 10 minutes')}
            </Badge>
          </HostOption>
        </RadioGroup>
        <div>
          <p className="text-xs text-muted-foreground">
            {t('bots.google.haveSetupFile', 'Have a setup file from your team?')}{' '}
            <Button
              variant="link"
              size="inlineText"
              disabled={file.busy}
              onClick={() => void file.pick()}
            >
              {t('bots.google.importSetupFile', 'Import file')}
            </Button>
          </p>
          {file.error ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {file.error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => start()}>
            {t('bots.google.hostChoice.continue', 'Continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
