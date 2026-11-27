import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'

export const getChatMarkdownImageSizeSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    targetSectionId: 'chat-markdown-image-size',
    title: translate('components.settings.nativeChat.markdownImageSizeTitle', 'Picture size'),
    description: translate(
      'components.settings.nativeChat.markdownImageSizeCopy',
      'Pictures in a message use this size and stay whole. Column width fills the message. Open a picture to see it full size.'
    ),
    keywords: ['picture', 'image', 'photo', 'column', 'compact', 'medium', 'width']
  })
)
