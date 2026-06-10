import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getNotificationsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.notifications.search.4a210b2f72',
      'Enable Notifications'
    ),
    description: translate(
      'auto.components.settings.notifications.search.0534c76311',
      'Master switch for Orca desktop notifications.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.51ae2183e1',
        'desktop'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.72539aede4',
        'system'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.adbc3a0fcf',
        'native'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.notifications.search.bdc1edaeb4',
      'Agent Task Complete'
    ),
    description: translate(
      'auto.components.settings.notifications.search.10d83ef8dc',
      'Notify when a coding agent transitions from working to idle.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.7fa07e9600',
        'agent'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.5f7472d3fb',
        'complete'
      ),
      ...translateSearchKeyword('auto.components.settings.notifications.search.dd9d3e5f0f', 'idle'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.193e1f107c', 'task')
    ]
  },
  {
    title: translate('auto.components.settings.notifications.search.a5edee1d99', 'Terminal Bell'),
    description: translate(
      'auto.components.settings.notifications.search.d3f1c48677',
      'Notify when a background terminal emits a bell character.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.c638ae989d',
        'terminal'
      ),
      ...translateSearchKeyword('auto.components.settings.notifications.search.ae0487f8fd', 'bell'),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.a2ab73b325',
        'attention'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.notifications.search.96562a72c6',
      'Suppress While Focused'
    ),
    description: translate(
      'auto.components.settings.notifications.search.7247b97a31',
      'Avoid notifying when Orca is focused on the active worktree.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.a4c3b29a3c',
        'focused'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.fa60d8e4ab',
        'suppress'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.4ada6bfde9',
        'filtering'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.notifications.search.ea8cb8d9ce',
      'Notification Sound'
    ),
    description: translate(
      'auto.components.settings.notifications.search.c718793e95',
      'Choose the built-in, system, or local audio file Orca plays for desktop notifications.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.dc7d7c07cd',
        'sound'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.6e08f78315',
        'audio'
      ),
      ...translateSearchKeyword('auto.components.settings.notifications.search.5362074f19', 'mp3'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.57e34a31cd', 'wav'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.d16ae23645', 'ogg'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.6ecb8418cb', 'm4a'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.722face52f', 'aac'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.079c29aeb5', 'flac'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.3014ad1b8f', 'ding'),
      ...translateSearchKeyword('auto.components.settings.notifications.search.ef86a782cc', 'bong')
    ]
  },
  {
    title: translate(
      'auto.components.settings.notifications.search.aace1a62c6',
      'Notification Volume'
    ),
    description: translate(
      'auto.components.settings.notifications.search.eeb6f77322',
      'Playback volume for non-system notification sounds.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.dc7d7c07cd',
        'sound'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.d58b64dddf',
        'volume'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ecdeff4993',
        'loudness'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.notifications.search.ef9b311346',
      'Send Test Notification'
    ),
    description: translate(
      'auto.components.settings.notifications.search.4e30b1925e',
      'Trigger a sample desktop notification using the native delivery path.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.notifications.search.ca8faa40d7',
        'notifications'
      ),
      ...translateSearchKeyword('auto.components.settings.notifications.search.aa288005c3', 'test')
    ]
  }
])
