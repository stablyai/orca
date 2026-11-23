// Add to <bot>: every app the bot can be given, in one wide dialog with a category rail. Each app is
// listed once under its direct route; Composio's apps have a section of their own. Add opens the app's
// setup: Orca's own connector dialogs, the Composio account and sign-in, Webhooks, or an app by URL.
import React, { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { openBotConnectorsTab } from './bot-settings-open'
import type { BotConnector } from './bot-connectors'
import { BotAppsCatalog, type BotAppsStep } from './apps/BotAppsCatalog'
import type { Bot } from '../../../../shared/bot-types'

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
  const title = t('bots.apps.title', 'Add to {{bot}}', { bot: bot.name })
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setStep(null)
        }
      }}
    >
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        data-step={step !== null}
        className="flex h-150 max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-190 data-[step=true]:h-auto data-[step=true]:sm:max-w-115"
      >
        {step === null ? (
          <div className="flex items-center gap-2 border-b border-border py-3.5 pr-3.5 pl-5">
            <DialogTitle className="min-w-0 flex-1">
              <span className="block truncate" title={title}>
                {title}
              </span>
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('bots.apps.close', 'Close')}
              onClick={() => onOpenChange(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <DialogTitle className="sr-only">{title}</DialogTitle>
        )}
        {open ? (
          <BotAppsCatalog
            bot={bot}
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
            onAdd={onAdd}
            step={step}
            setStep={setStep}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
