import { Bot as BotIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import { botAgentLabel } from '@/components/bots/bot-presentation'
import { ACCOUNT_CONNECTORS } from '@/components/bots/bot-connectors'
import {
  BOTS_SETTINGS_SECTION_ID,
  botSettingsSectionId
} from '@/components/settings/bots/bot-settings-section-ids'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

// Bots live on this computer; a web client has none of its own.

/** The Bots page, under Set Up. */
export function buildBotsPageSettingsSections({
  isWebClient
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  // Shown with bots off too: it holds the switch that turns them back on.
  if (isWebClient) {
    return []
  }
  return [
    {
      id: BOTS_SETTINGS_SECTION_ID,
      title: translate('settings.bots.title', 'Bots'),
      description: translate(
        'settings.bots.description',
        'Your AI teammate with a name, memory and automations.'
      ),
      icon: BotIcon,
      searchEntries: [
        {
          title: translate('settings.bots.title', 'Bots'),
          keywords: [translate('settings.bots.connectors', 'Connectors')]
        }
      ],
      group: 'setup'
    }
  ]
}

/** One page per bot in the Bots group, as each project gets one. */
export function buildBotSettingsSections({
  isWebClient,
  botsEnabled,
  bots
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  if (isWebClient || !botsEnabled) {
    return []
  }
  return bots.map((bot) => ({
    id: botSettingsSectionId(bot.id),
    title: bot.name,
    description: botAgentLabel(bot.agent),
    icon: BotIcon,
    searchEntries: [
      {
        title: bot.name,
        keywords: [
          translate('settings.bots.soul', 'Soul'),
          translate('settings.bots.memory', 'Memory'),
          translate('settings.bots.permissions', 'Permissions'),
          translate('settings.bots.notifications', 'Notifications'),
          translate('settings.bots.connectors', 'Connectors'),
          // Not Webhooks: only the bot's host knows whether it offers them, and asking means a host read.
          ...ACCOUNT_CONNECTORS.filter((connector) => connector.available).map(
            (connector) => connector.label
          ),
          translate('settings.bots.whoCanAsk', 'Who can ask {{bot}}', { bot: bot.name })
        ]
      }
    ],
    group: 'bots',
    bot
  }))
}
