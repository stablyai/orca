import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'

export function getChatPermissionSearchEntry(): SettingsSearchEntry {
  return {
    targetSectionId: 'chat-permissions',
    title: translate('settings.chat.permissionsTitle', 'Permissions for new chats'),
    description: translate(
      'settings.chat.permissionsDescription',
      'Applies to new chats only. Agents you open in a terminal use Settings → Agents → Agent Permissions.'
    )
  }
}
