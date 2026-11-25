// Add apps to <bot>: every app the bot can be given, in one wide dialog filtered by chips. Each app is
// listed once under its direct route; Composio's apps have a section of their own. Add opens the app's
// setup: Orca's own connector dialogs, the Composio account and sign-in, Webhooks, or an app by URL.
import React, { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { openBotConnectorsTab } from './bot-settings-open'
import type { BotConnector } from './bot-connectors'
import { BotAppsCatalog, type BotAppsStep } from './apps/BotAppsCatalog'
import type { Bot } from '../../../../shared/bot-types'
import { GoogleAccountsStep, useGoogleSignedInFor } from './google/GoogleAccountsChoice'

export type BotConnectorId = BotConnector['id']

/** What a connector does for a bot, as Add connector and the chat's Connect card word it. */
export function connectorDescription(id: BotConnectorId): string {
  switch (id) {
    case 'feishu-local':
      return translate('bots.feishu.line', 'Private messages through Feishu CLI on this host')
    case 'webhooks':
      return translate(
        'bots.connectors.webhooks',
        'Let any tool or script start the bot with a web request. Set up in chat.'
      )
    case 'slack':
      return translate(
        'bots.connectors.slack',
        'Chat with the bot from Slack channels and direct messages.'
      )
    case 'discord':
      return translate(
        'bots.connectors.discord',
        'Chat with the bot from Discord channels, threads, and direct messages.'
      )
    case 'google':
      return translate(
        'bots.connectors.google',
        'Let the bot work in your Gmail, Calendar and Drive, and start automations on new mail.'
      )
    case 'linear':
      return translate(
        'bots.connectors.linear',
        'Hand the bot issues by @mentioning or assigning it, and start automations on Linear events.'
      )
    case 'github':
      return translate(
        'bots.connectors.github',
        'Hand the bot work by @mentioning it, and start automations on GitHub events.'
      )
  }
}

/** The bot page's Connectors tab; from inside Settings, which lists them too, the dialog only closes. */
export function manageConnectors(bot: Bot, entryKey?: string): void {
  if (useAppStore.getState().activeView !== 'settings') {
    openBotConnectorsTab(bot, entryKey)
  }
}

export function AddConnectorDialog({
  bot,
  open,
  onOpenChange,
  onAdd
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (connector: BotConnectorId) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [step, setStep] = useState<BotAppsStep | null>(null)
  // Google signed in on the bot's host: its Add continues here, on which accounts the bot may use.
  const [googleStep, setGoogleStep] = useState(false)
  const googleSignedIn = useGoogleSignedInFor(bot, open)
  const title = t('bots.apps.addAppsTitle', 'Add apps to {{bot}}', { bot: bot.name })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setStep(null)
          setGoogleStep(false)
        }
      }}
    >
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        data-step={step !== null || googleStep}
        className="flex h-175 max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-[min(57.5rem,calc(100vw-4rem))] data-[step=true]:h-auto data-[step=true]:sm:max-w-115"
      >
        {step !== null || googleStep ? (
          <DialogTitle className="sr-only">{title}</DialogTitle>
        ) : null}
        {open && googleStep ? (
          <GoogleAccountsStep
            bot={bot}
            onBack={() => setGoogleStep(false)}
            onClose={() => {
              onOpenChange(false)
              setGoogleStep(false)
            }}
          />
        ) : open ? (
          <BotAppsCatalog
            bot={bot}
            title={title}
            onOpenChange={(next) => {
              onOpenChange(next)
              if (!next) {
                setStep(null)
              }
            }}
            onManage={() => {
              onOpenChange(false)
              setStep(null)
              manageConnectors(bot)
            }}
            onAdd={(connector) =>
              connector === 'google' && googleSignedIn ? setGoogleStep(true) : onAdd(connector)
            }
            step={step}
            setStep={setStep}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
