import React from 'react'
import { Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { cn } from '@/lib/class-names'
import type { Bot } from '../../../../../shared/bot-types'
import type { GoogleAccountView } from '../../../../../shared/google/google-connect-types'
import {
  botOtherAskers,
  googleWhoCanAskWarning
} from '../../../../../shared/google/google-who-can-ask-warning'
import { BotPictureRowFold } from '../BotPictureRowFold'
import { STATUS_DOT_CLASSES } from '../bot-connector-row-parts'
import { googleSignInChoices } from './google-account-readiness'
import { toggleGoogleAccount, withGoogleAccount } from './google-account-choice'
import { useGoogleHost } from './google-connect-client'
import { googleServiceLabel } from './google-copy'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { useGoogleSignIn } from './use-google-sign-in'

export type GoogleAccountPickerBot = Pick<Bot, 'id' | 'name' | 'members'> & BotOnHost

/**
 * The Google accounts on the bot's host, each a row that ticks it for the bot, then Add another
 * account. Who else can then have the bot use them folds in under the list once one is ticked.
 */
export function GoogleAccountPicker({
  bot,
  chosen,
  onChosenChange,
  signInMemoryKey
}: {
  bot: GoogleAccountPickerBot
  chosen: readonly string[]
  onChosenChange: React.Dispatch<React.SetStateAction<string[]>>
  /** A picker in a chat's setup card: a sign-in still waiting stays shown, and cancellable, after a switch. */
  signInMemoryKey?: string
}): React.JSX.Element {
  const t = useTranslate()
  const view = useGoogleHost(botTarget(bot))
  const signIn = useGoogleSignIn(botTarget(bot), bot, signInMemoryKey)
  const accounts = view.status === 'ready' ? view.google.accounts : []
  const warning = googleWhoCanAskWarning(bot.name, botOtherAskers(bot))
  // A sign-in from here (another account, or a reconnect) ticks the account it signed in.
  const signInAs = async (account?: GoogleAccountView): Promise<void> => {
    const connected = await signIn.connect(googleSignInChoices(account), account?.email)
    if (connected) {
      onChosenChange((current) => withGoogleAccount(current, connected.email))
    }
  }
  return (
    <div className="flex flex-col">
      <div role="group" aria-label={t('bots.google.picker.label', 'Google accounts')}>
        {accounts.map((account) => (
          <GoogleAccountPickerRow
            key={account.email}
            account={account}
            on={chosen.includes(account.email.toLowerCase())}
            onToggle={() =>
              onChosenChange((current) => toggleGoogleAccount(current, account.email))
            }
            onReconnect={() => void signInAs(account)}
          />
        ))}
      </div>
      {signIn.state.kind === 'waiting' ? (
        <div className="p-2">
          <GoogleSignInWaiting state={signIn.state} onCancel={signIn.cancel} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void signInAs()}
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50">
            <Plus className="size-3.5" />
          </span>
          {t('bots.google.picker.addAccount', 'Add another account')}
        </button>
      )}
      {signIn.state.kind === 'failed' ? (
        <p role="alert" className="px-2 pt-1 text-xs text-destructive">
          {signIn.state.error}
        </p>
      ) : null}
      <BotPictureRowFold open={warning !== null && chosen.length > 0} className="px-2 pt-3">
        <p className="text-xs leading-[18px] text-muted-foreground">{warning}</p>
      </BotPictureRowFold>
    </div>
  )
}

export function GoogleAccountPickerRow({
  account,
  on,
  onToggle,
  onReconnect
}: {
  account: GoogleAccountView
  on: boolean
  onToggle: () => void
  onReconnect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const signedOut = account.status !== 'connected'
  const services = new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(
    account.services
      .filter((entry) => entry.state === 'ready' && entry.service !== 'contacts')
      .map((entry) => googleServiceLabel(entry.service))
  )
  return (
    // The toggle is a button stretched over the row; Reconnect sits beside it, a control of its own.
    <div className="group/row relative flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent/40">
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
      >
        {account.email.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          onClick={onToggle}
          className="block max-w-full cursor-default truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
        >
          {account.email}
        </button>
        {signedOut ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={STATUS_DOT_CLASSES.attention} aria-hidden />
            <span className="truncate">
              {t('bots.google.row.signedOut', 'Signed out by Google')}
            </span>
          </span>
        ) : (
          <span className="block truncate text-xs text-muted-foreground">{services}</span>
        )}
      </span>
      {signedOut ? (
        <Button
          size="xs"
          variant="outline"
          className="relative"
          aria-label={t('bots.google.bot.reconnectAccount', 'Reconnect {{email}}', {
            email: account.email
          })}
          onClick={onReconnect}
        >
          {t('bots.google.reconnect', 'Reconnect')}
        </Button>
      ) : null}
      <Check
        aria-hidden
        className={cn(
          'size-4 shrink-0 transition-[opacity,scale] duration-150 motion-reduce:transition-none',
          on ? 'scale-100 opacity-100' : 'scale-85 opacity-0'
        )}
      />
    </div>
  )
}
