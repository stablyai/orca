import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatProvidersSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-providers',
  title: translate('settings.chat.providers.title', 'Providers'),
  description: translate(
    'settings.chat.providers.description',
    'Choose which agents open as a chat. Turned off, an installed agent opens in a terminal.'
  ),
  keywords: [
    translate('settings.chat.providers.searchAgents', 'agents'),
    translate('settings.chat.providers.searchCli', 'CLI'),
    translate('settings.chat.providers.searchTerminal', 'terminal')
  ]
}))
