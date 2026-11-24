// @protected-copy
import type React from 'react'
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
import { setBotGoogle, useGoogleHost } from './google-connect-client'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { googleSignInChoices } from './google-account-readiness'
import { GoogleSignInWaiting } from './GoogleSignInWaiting'
import { useGoogleSignIn } from './use-google-sign-in'

/** Settings › Bots, where each computer lists its Google accounts and default. */
function openGoogleSettings(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({ pane: 'bots', repoId: null })
  openSettingsPage()
}

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
  const settingUp = googleSetupRunActive(useGoogleSetupRun(bot))
  if (view.status !== 'ready' || bot.google !== true) {
    return null
  }
  const accounts = view.google.accounts
  const connected = accounts.length > 0
  // A host too old to keep a default reports none; the row then lists every account as before.
  const defaultAccount = view.google.defaultAccount
  const fallback = accounts.find((account) => account.email === defaultAccount)
  const others = accounts.filter((account) => account !== fallback).map((entry) => entry.email)
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
    void stopGoogleSetup(bot).catch((error: unknown) => toast.error(botErrorMessage(error)))
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
          ? (fallback?.email ?? accounts.map((account) => account.email).join(', '))
          : host
            ? t('bots.google.bot.signedOutOnHost', 'Not connected on {{host}}', { host })
            : t('bots.google.bot.signedOut', 'Not connected on this computer')
      }
      status={
        settingUp ? { label: t('bots.google.bot.settingUp', 'Setting up'), tone: 'neutral' } : null
      }
      fix={connected ? null : { label: t('bots.google.connect', 'Connect Google'), onClick: setUp }}
      actions={{
        ...(connected && defaultAccount !== undefined
          ? {
              addAccount: {
                label: t('bots.google.addAccount', 'Add another Google account'),
                onClick: () => void signIn.connect(googleSignInChoices(fallback))
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
          ...(fallback
            ? [
                {
                  label: t('bots.google.bot.account', 'Account'),
                  value: (
                    <>
                      <span className="block truncate">{fallback.email}</span>
                      <span className="text-muted-foreground">
                        {host
                          ? t('bots.google.bot.hostDefault', '{{host}}’s default', { host })
                          : t('bots.google.bot.computerDefault', 'This computer’s default')}
                        {' · '}
                      </span>
                      <Button variant="link" size="inlineText" onClick={openGoogleSettings}>
                        {t('bots.google.bot.changeInSettings', 'Change in Settings')}
                      </Button>
                    </>
                  )
                }
              ]
            : []),
          ...(fallback && others.length > 0
            ? [
                {
                  label: t('bots.google.bot.alsoConnected', 'Also connected'),
                  value: others.join(', ')
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
