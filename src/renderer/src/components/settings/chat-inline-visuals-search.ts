import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatInlineVisualsSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  targetSectionId: 'chat-inline-visuals',
  title: translate('components.settings.nativeChat.inlineVisualsTitle', 'Inline visuals'),
  description: translate(
    'components.settings.nativeChat.inlineVisualsCopy',
    'Let the agent show charts, diagrams and mockups inside its replies. Applies to newly started chats.'
  )
}))
