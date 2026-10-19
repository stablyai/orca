import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatPermissionSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-permissions',
  title: translate('settings.chat.permissionsTitle', 'Permissions for new chats'),
  description: translate(
    'settings.chat.permissionsDescription',
    'Applies to new chats only. Agents you open in a terminal use Settings → Agents → Agent Permissions.'
  )
}))
