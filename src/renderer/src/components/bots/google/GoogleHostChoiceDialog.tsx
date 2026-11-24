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
import { cn } from '@/lib/class-names'
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
  note
}: {
  value: string
  disabled?: boolean
  title: string
  badge?: React.ReactNode
  note: string
}): React.JSX.Element {
  const id = useId()
  return (
    // Why the ring: a disabled radio's faded border all but vanishes on the light dialog.
    <div className="flex items-start gap-3 rounded-lg border border-border p-3 has-disabled:bg-card has-[[data-state=checked]]:border-foreground/60 has-[[data-state=checked]]:bg-accent [&>[data-slot=radio-group-item]:disabled]:border-muted-foreground">
      <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-0.5" />
      {/* Why muted, not faded: fading the card let what's behind it show through. */}
      <div
        className={cn('flex min-w-0 flex-1 flex-col gap-0.5', disabled && 'text-muted-foreground')}
      >
        <Label htmlFor={id} variant="control">
          {title}
          {badge}
        </Label>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    </div>
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
        <DialogHeader className="text-left">
          <DialogTitle>{t('bots.google.connect', 'Connect Google')}</DialogTitle>
          <DialogDescription className="sr-only">
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
            badge={<Badge variant="comingSoon">{t('bots.google.hostChoice.soon', 'Soon')}</Badge>}
            note={t('bots.google.hostChoice.orcaNote', 'Sign in with Google.')}
          />
          <HostOption
            value="self"
            title={t('bots.google.hostChoice.self', 'Self hosted')}
            note={t('bots.google.hostChoice.selfNote', 'Your own Google app.')}
          />
        </RadioGroup>
        {file.error ? (
          <p role="alert" className="text-xs text-destructive">
            {file.error}
          </p>
        ) : null}
        <DialogFooter className="@container flex-row flex-wrap items-center justify-end">
          <Button
            variant="ghost"
            size="responsive-sm"
            className="mr-auto"
            disabled={file.busy}
            onClick={() => void file.pick()}
          >
            {t('bots.google.importSetupFile', 'Import file')}
          </Button>
          {/* Keep both actions on the same line when the footer wraps. */}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="responsive-sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="responsive-sm" onClick={() => start()}>
              {t('bots.google.hostChoice.continue', 'Continue')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
