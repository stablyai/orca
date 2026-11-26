import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { openBotConnectorsTab } from './bot-settings-open'
import type { BotConnector } from './bot-connectors'
import type { Bot } from '../../../../shared/bot-types'

export type BotConnectorId = BotConnector['id']

/** What a connector does for a bot, as Add connector and the chat's Connect card word it. */
export function connectorDescription(id: BotConnectorId): string {
  switch (id) {
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
