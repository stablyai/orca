// @protected-copy
import React, { useState } from 'react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { GoogleIcon } from '@/components/icons/GoogleIcon'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotConnectorDetails, BotConnectorRowFrame } from '../BotConnectorRow'
import type { BotConnectorTitle } from '../bot-connector-titles'
import { botErrorMessage } from '../bot-presentation'
import {
  startGoogleSetupInChat,
  stopGoogleSetup,
  useGoogleSetupRun
} from './setup-cards/google-setup-run-store'
import { googleSetupRunActive } from '../../../../../shared/google/google-setup-run'
import { botTarget } from '@/lib/bot-hosts'
import { googleServiceLabel } from './google-copy'
import { useBotHostLabel } from '../use-bot-host-label'
import { useGoogleHost } from './google-connect-client'
import { setBotGoogle } from './set-bot-google'
import { Button } from '@/components/ui/button'
import { googleSignInChoices } from './google-account-readiness'
import {
  botGoogleAccess,
  botMayUseGoogleAccount
} from '../../../../../shared/google/google-bot-accounts'
import type { GoogleAccountView } from '../../../../../shared/google/google-connect-types'
import { STATUS_DOT_CLASSES } from '../bot-connector-row-parts'
import { GoogleAccountsPopover } from './GoogleAccountsChoice'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { useGoogleSignIn } from './use-google-sign-in'

/**
 * Settings › Bots › Connectors › Google, once Google is added to the bot (Add a connector). It lets
 * the bot use the owner's Google on this computer; Remove takes it off the bot.
 */
export function BotGoogleCard({
  bot,
  title,
  defaultOpen
}: {
  bot: Bot
  /** The row's title from the bot's connector list; see botConnectorTitles. */
  title?: BotConnectorTitle
  defaultOpen?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const view = useGoogleHost(botTarget(bot))
  const confirm = useConfirmationDialog()
  const host = useBotHostLabel(bot.hostId)
  const signIn = useGoogleSignIn(botTarget(bot), bot)
  const setupRun = useGoogleSetupRun(bot)
  const settingUp = googleSetupRunActive(setupRun)
  const [choosing, setChoosing] = useState(false)
  if (view.status !== 'ready' || bot.google !== true) {
    return null
  }
  // The accounts on this computer the bot may use; a signed-out one stays chosen.
  const access = botGoogleAccess(bot)
  const accounts = view.google.accounts.filter((account) =>
    botMayUseGoogleAccount(access, account.email)
  )
  const connected = view.google.accounts.length > 0
  const signedOut = accounts.find((account) => account.status !== 'connected')
  const reconnect = (account: GoogleAccountView): void =>
    void signIn.connect(googleSignInChoices(account), account.email)
  const ready = [
    ...new Set(
      accounts.flatMap((account) =>
        account.services
          .filter((entry) => entry.state === 'ready' && entry.service !== 'contacts')
          .map((entry) => googleServiceLabel(entry.service))
      )
    )
  ]
  // Added, but nobody is signed in on this computer: the bot sets Google up in its own chat.
  const setUp = (): void => {
    void startGoogleSetupInChat(bot, 'settings').catch((error: unknown) =>
      toast.error(botErrorMessage(error))
    )
  }
  const stop = (): void => {
    if (!setupRun) {
      return
    }
    void stopGoogleSetup(bot, setupRun.id).catch((error: unknown) =>
      toast.error(botErrorMessage(error))
    )
  }
  const remove = async (): Promise<void> => {
    const confirmed = await confirm({
      title: t('bots.google.bot.removeTitle', 'Remove Google from {{name}}?', {
        name: bot.name
      }),
      description: host
        ? t(
            'bots.google.bot.removeNoteOnHost',
            '{{name}} can no longer use your Gmail, Calendar and Drive. Google stays connected on {{host}}.',
            { name: bot.name, host }
          )
        : t(
            'bots.google.bot.removeNote',
            '{{name}} can no longer use your Gmail, Calendar and Drive. Google stays connected on this computer.',
            { name: bot.name }
          ),
      confirmLabel: t('bots.linear.connection.removeConfirm', 'Remove'),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await setBotGoogle(bot, false).catch((error: unknown) => toast.error(botErrorMessage(error)))
    }
  }
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotAppBrandLogo app={{ id: 'google', Icon: GoogleIcon }} />}
      name={title ?? 'Google'}
      defaultOpen={defaultOpen}
      description={
        connected
          ? accounts.map((account) => account.email).join(', ')
          : host
            ? t('bots.google.bot.signedOutOnHost', 'Not connected on {{host}}', { host })
            : t('bots.google.bot.signedOut', 'Not connected on this computer')
      }
      status={
        settingUp ? { label: t('bots.google.bot.settingUp', 'Setting up'), tone: 'neutral' } : null
      }
      fix={
        settingUp
          ? null
          : !connected
            ? { label: t('bots.google.connect', 'Connect Google'), onClick: setUp }
            : signedOut
              ? {
                  label: t('bots.google.bot.reconnectAccount', 'Reconnect {{email}}', {
                    email: signedOut.email
                  }),
                  onClick: () => reconnect(signedOut),
                  // The sign-in's waiting and Cancel show in the row's panel.
                  opensRow: true
                }
              : null
      }
      actions={{
        ...(connected
          ? {
              accounts: {
                label: t('bots.google.bot.chooseAccounts', 'Choose accounts…'),
                // After the menu has closed, so its focus return can't close the popover.
                onClick: () => requestAnimationFrame(() => setChoosing(true))
              }
            }
          : {}),
        ...(settingUp
          ? { stop: { label: t('bots.googleSetup.stop', 'Stop setup'), onClick: stop } }
          : {}),
        remove: {
          label: t('bots.google.bot.remove', 'Remove Google…'),
          onSelect: () => void remove()
        }
      }}
      menuPopover={{
        open: choosing,
        onOpenChange: setChoosing,
        content: choosing ? (
          <GoogleAccountsPopover
            bot={bot}
            onClose={() => setChoosing(false)}
            onRemove={() => void remove()}
          />
        ) : null
      }}
    >
      {signIn.state.kind === 'waiting' ? (
        <GoogleSignInWaiting state={signIn.state} onCancel={signIn.cancel} />
      ) : signIn.state.kind === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {signIn.state.error}
        </p>
      ) : null}
      <BotConnectorDetails
        rows={[
          ...(accounts.length > 0
            ? [
                {
                  label:
                    accounts.length > 1
                      ? t('bots.google.bot.accounts', 'Accounts')
                      : t('bots.google.bot.account', 'Account'),
                  value: accounts.map((account) => (
                    <span key={account.email} className="block">
                      <span className="block truncate">{account.email}</span>
                      {account.status !== 'connected' ? (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className={STATUS_DOT_CLASSES.attention} aria-hidden />
                          {t('bots.google.row.signedOut', 'Signed out by Google')}
                          {' · '}
                          <Button
                            variant="link"
                            size="inlineText"
                            onClick={() => reconnect(account)}
                          >
                            {t('bots.google.reconnect', 'Reconnect')}
                          </Button>
                        </span>
                      ) : null}
                    </span>
                  ))
                }
              ]
            : []),
          {
            label: t('bots.google.bot.uses', 'What it can use'),
            value:
              ready.length > 0
                ? new Intl.ListFormat(intlLocale, { type: 'conjunction' }).format(ready)
                : t('bots.google.bot.nothingYet', 'Nothing yet. Connect Google first.')
          },
          {
            label: t('bots.google.bot.who', 'Who can use it'),
            value: t(
              'bots.google.bot.whoNote',
              'Anyone who can ask {{name}} can have it read and send your email, calendar and files.',
              { name: bot.name }
            )
          }
        ]}
      />
    </BotConnectorRowFrame>
  )
}
