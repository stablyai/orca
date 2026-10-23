import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'

export const getChatTransientErrorRecoverySearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    targetSectionId: 'chat-transient-error-recovery',
    title: translate(
      'components.settings.nativeChat.transientErrorRecoveryTitle',
      'Automatically continue after temporary provider errors'
    ),
    description: translate(
      'components.settings.nativeChat.transientErrorRecoveryCopy',
      'For supported Codex chats, send a continuation after capacity, overload, service or connection errors, up to 3 times after 10, 30 and 60 seconds. Keeps the same model and account, even when the chat view is closed. Sending a message, stopping or closing the chat cancels pending attempts.'
    ),
    keywords: [
      translate(
        'components.settings.nativeChat.transientErrorRecoveryKeywords',
        'capacity overloaded unavailable connection retry continue'
      )
    ]
  })
)
