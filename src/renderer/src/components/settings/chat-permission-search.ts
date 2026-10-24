import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

const getTypedEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-permissions',
  title: translate('settings.chat.permissionsTitle', 'Permissions for new chats'),
  // Temporary until chats can run an agent's own settings.
  description: translate(
    'settings.chat.permissionsDescriptionOwnAgents',
    'New chats of agents set to their own settings in Settings → Agents. Other agents start chats in their permission there.'
  )
}))

const getLegacyEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-permissions',
  title: translate('settings.chat.permissionsTitle', 'Permissions for new chats'),
  description: translate(
    'settings.chat.permissionsDescription',
    'New chats only. Agent-specific defaults are in Settings → Agents.'
  )
}))

export function getChatPermissionSearchEntry(typedPermissions = false): SettingsSearchEntry {
  return typedPermissions ? getTypedEntry() : getLegacyEntry()
}
