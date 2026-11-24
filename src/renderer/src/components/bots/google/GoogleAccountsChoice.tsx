// Where the owner picks a bot's Google accounts: a step of Add to <bot> (or its own dialog when
// Google is added from elsewhere), and a popover on the Google row's ⋯ to change them later.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { PopoverContent } from '@/components/ui/popover'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { googleBotConnectState } from '../../../../../shared/google/google-bot-connect-state'
import type { Bot } from '../../../../../shared/bot-types'
import { botAskerKeys } from '../../../../../shared/google/google-who-can-ask-warning'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { BotAppStepHeader, BotAppStepHeading } from '../apps/BotAppStepParts'
import { botErrorMessage } from '../bot-presentation'
import { googleAccountChoiceSave, initialGoogleAccountChoice } from './google-account-choice'
import { useGoogleHost } from './google-connect-client'
import { setBotGoogle } from './set-bot-google'
import { GoogleAccountPicker, type GoogleAccountPickerBot } from './GoogleAccountPicker'

export type GoogleAccountChoiceBot = GoogleAccountPickerBot & Pick<Bot, 'google' | 'googleAccounts'>

/** The picker's ticks, starting from what the bot has once the host's accounts are read, and Save. */
export function useGoogleAccountChoice(
  bot: GoogleAccountChoiceBot,
  added?: string
): {
  chosen: string[]
  setChosen: React.Dispatch<React.SetStateAction<string[]>>
  /** The host's accounts are read; until then nothing is ticked, and saving would remove them all. */
  ready: boolean
  saving: boolean
  save: () => Promise<boolean>
} {
  const view = useGoogleHost(botTarget(bot))
  const [picked, setPicked] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const initial =
    view.status === 'ready'
      ? initialGoogleAccountChoice(
          bot,
          view.google.accounts,
          view.google.defaultAccount ?? null,
          added
        )
      : []
  const chosen = picked ?? initial
  const setChosen: React.Dispatch<React.SetStateAction<string[]>> = (update) =>
    setPicked((current) => (typeof update === 'function' ? update(current ?? initial) : update))
  const save = async (): Promise<boolean> => {
    const next = googleAccountChoiceSave(chosen)
    setSaving(true)
    // The askers the picker showed: the host keeps Google off if Who can ask changed meanwhile.
    const saved = await setBotGoogle(
      bot,
      next.on,
      next.on ? { accounts: next.accounts, confirmedAskers: botAskerKeys(bot) } : {}
    ).then(
      () => true,
      (error: unknown) => {
        toast.error(botErrorMessage(error))
        return false
      }
    )
    setSaving(false)
    return saved
  }
  return { chosen, setChosen, ready: view.status === 'ready', saving, save }
}

function GoogleAccountsCaption({ bot }: { bot: Pick<Bot, 'name'> }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="pb-1 text-2xs font-semibold text-muted-foreground">
      {t('bots.google.picker.caption', 'Accounts {{bot}} can use', { bot: bot.name })}
    </p>
  )
}

/** Whether Google is signed in on the bot's host, so adding it goes straight to its accounts. */
export function useGoogleSignedInFor(
  bot: Pick<Bot, 'google'> & BotOnHost,
  shown: boolean
): boolean {
  // Read only while shown, so a closed Add to <bot> asks the host nothing.
  const view = useGoogleHost(botTarget(bot), shown)
  return (
    view.status === 'ready' &&
    googleBotConnectState({
      allowed: bot.google === true,
      client: view.google.client,
      accounts: view.google.accounts
    }).host === 'connected'
  )
}

/** Add to <bot>'s Google step: the accounts, then Add. Without `onBack`, it stands alone. */
export function GoogleAccountsStep({
  bot,
  onBack,
  onClose
}: {
  bot: Bot
  onBack?: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const choice = useGoogleAccountChoice(bot)
  return (
    <>
      <BotAppStepHeader onBack={onBack} onClose={onClose} />
      {/* Scrolls under the header when the accounts outgrow the dialog. */}
      <div className="scrollbar-sleek min-h-0 overflow-y-auto px-6 pt-1 pb-6">
        <BotAppStepHeading
          logo={<BotAppBrandLogo app={{ id: 'google', Icon: GoogleIcon }} size="lg" />}
          title={t('bots.google.title', 'Google')}
          line={t('bots.apps.line.google', 'Gmail, Calendar and Drive, as you')}
        />
        <GoogleAccountsCaption bot={bot} />
        <div className="-mx-2">
          <GoogleAccountPicker bot={bot} chosen={choice.chosen} onChosenChange={choice.setChosen} />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={choice.chosen.length === 0 || choice.saving || !choice.ready}
            onClick={() => void choice.save().then((saved) => saved && onClose())}
          >
            {t('bots.apps.add', 'Add')}
          </Button>
        </div>
      </div>
    </>
  )
}

/** The Google step on its own, for adding Google from outside Add to <bot> (e.g. a chat's offer card). */
export function GoogleAccountsDialog({
  bot,
  open,
  onOpenChange
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-115"
      >
        <DialogTitle className="sr-only">
          {t('bots.apps.addAppsTitle', 'Add apps to {{bot}}', { bot: bot.name })}
        </DialogTitle>
        {open ? <GoogleAccountsStep bot={bot} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

/** Choose accounts… on the Google row's ⋯: the same list in a popover, then Save. */
export function GoogleAccountsPopover({
  bot,
  onClose,
  onRemove
}: {
  bot: GoogleAccountChoiceBot
  onClose: () => void
  /** Saving with nothing ticked: Remove Google, with its own confirm. */
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const choice = useGoogleAccountChoice(bot)
  return (
    <PopoverContent align="end" className="w-81">
      <div className="px-3 pt-3">
        <GoogleAccountsCaption bot={bot} />
      </div>
      <div className="p-1">
        <GoogleAccountPicker bot={bot} chosen={choice.chosen} onChosenChange={choice.setChosen} />
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-2">
        <Button variant="ghost" size="xs" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          size="xs"
          disabled={choice.saving || !choice.ready}
          onClick={() => {
            if (choice.chosen.length === 0) {
              onClose()
              onRemove()
              return
            }
            void choice.save().then((saved) => saved && onClose())
          }}
        >
          {t('bots.google.picker.save', 'Save')}
        </Button>
      </div>
    </PopoverContent>
  )
}
