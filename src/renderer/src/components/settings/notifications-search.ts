import { translate } from '@/i18n/i18n'
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.51ae2183e1', 'desktop'),
      translate('auto.components.settings.notifications.search.72539aede4', 'system'),
      translate('auto.components.settings.notifications.search.adbc3a0fcf', 'native')
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.7fa07e9600', 'agent'),
      translate('auto.components.settings.notifications.search.5f7472d3fb', 'complete'),
      translate('auto.components.settings.notifications.search.dd9d3e5f0f', 'idle'),
      translate('auto.components.settings.notifications.search.193e1f107c', 'task')
    ]
  },
  {
    title: translate('auto.components.settings.notifications.search.a5edee1d99', 'Terminal Bell'),
    description: translate(
      'auto.components.settings.notifications.search.d3f1c48677',
      'Notify when a background terminal emits a bell character.'
    ),
    keywords: [
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.c638ae989d', 'terminal'),
      translate('auto.components.settings.notifications.search.ae0487f8fd', 'bell'),
      translate('auto.components.settings.notifications.search.a2ab73b325', 'attention')
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.a4c3b29a3c', 'focused'),
      translate('auto.components.settings.notifications.search.fa60d8e4ab', 'suppress'),
      translate('auto.components.settings.notifications.search.4ada6bfde9', 'filtering')
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.dc7d7c07cd', 'sound'),
      translate('auto.components.settings.notifications.search.6e08f78315', 'audio'),
      translate('auto.components.settings.notifications.search.5362074f19', 'mp3'),
      translate('auto.components.settings.notifications.search.57e34a31cd', 'wav'),
      translate('auto.components.settings.notifications.search.d16ae23645', 'ogg'),
      translate('auto.components.settings.notifications.search.6ecb8418cb', 'm4a'),
      translate('auto.components.settings.notifications.search.722face52f', 'aac'),
      translate('auto.components.settings.notifications.search.079c29aeb5', 'flac'),
      translate('auto.components.settings.notifications.search.3014ad1b8f', 'ding'),
      translate('auto.components.settings.notifications.search.ef86a782cc', 'bong')
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.dc7d7c07cd', 'sound'),
      translate('auto.components.settings.notifications.search.d58b64dddf', 'volume'),
      translate('auto.components.settings.notifications.search.ecdeff4993', 'loudness')
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
      translate('auto.components.settings.notifications.search.ca8faa40d7', 'notifications'),
      translate('auto.components.settings.notifications.search.aa288005c3', 'test')
    ]
  }
])
