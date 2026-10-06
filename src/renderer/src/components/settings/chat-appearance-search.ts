import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'

const getChatAppearanceCatalog = createLocalizedCatalog(
  () =>
    ({
      textSize: {
        targetSectionId: 'chat-text-size',
        title: translate('settings.appearance.chat.textSize', 'Text size'),
        keywords: [translate('settings.appearance.chat.title', 'Chat')]
      },
      codeTextSize: {
        targetSectionId: 'chat-code-text-size',
        title: translate('settings.appearance.chat.codeTextSize', 'Code text size'),
        description: translate(
          'settings.appearance.chat.codeTextSizeDescription',
          'Code blocks, inline code, commands and tool output.'
        ),
        keywords: [translate('settings.appearance.chat.title', 'Chat')]
      },
      width: {
        targetSectionId: 'chat-width',
        title: translate('settings.appearance.chat.width', 'Width'),
        description: translate(
          'settings.appearance.chat.widthDescription',
          'How wide messages and the message box can grow in a wide pane.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat'),
          ...getChatWidthOptions().map((option) => option.label)
        ]
      },
      textColorLight: {
        targetSectionId: 'chat-text-color-light',
        title: translate('settings.appearance.chat.textColorLight', 'Text color (light theme)'),
        description: translate(
          'settings.appearance.chat.textColorLightDescription',
          'Messages, their markdown and code, and the message box in the light theme. Leave empty for the theme color.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat'),
          translate('settings.appearance.chat.fontColorKeyword', 'font color')
        ]
      },
      textColorDark: {
        targetSectionId: 'chat-text-color-dark',
        title: translate('settings.appearance.chat.textColorDark', 'Text color (dark theme)'),
        description: translate(
          'settings.appearance.chat.textColorDarkDescription',
          'Messages, their markdown and code, and the message box in the dark theme. Leave empty for the theme color.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat'),
          translate('settings.appearance.chat.fontColorKeyword', 'font color')
        ]
      },
      userBubbleColorLight: {
        targetSectionId: 'chat-user-bubble-color-light',
        title: translate(
          'settings.appearance.chat.userBubbleColorLight',
          'Your message bubble (light theme)'
        ),
        description: translate(
          'settings.appearance.chat.userBubbleColorLightDescription',
          'Background of your messages in the light theme. Leave empty for the theme color.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat'),
          translate('settings.appearance.chat.bubbleKeyword', 'bubble')
        ]
      },
      userBubbleColorDark: {
        targetSectionId: 'chat-user-bubble-color-dark',
        title: translate(
          'settings.appearance.chat.userBubbleColorDark',
          'Your message bubble (dark theme)'
        ),
        description: translate(
          'settings.appearance.chat.userBubbleColorDarkDescription',
          'Background of your messages in the dark theme. Leave empty for the theme color.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat'),
          translate('settings.appearance.chat.bubbleKeyword', 'bubble')
        ]
      },
      reset: {
        targetSectionId: 'chat-reset',
        title: translate('settings.appearance.chat.resetAppearance', 'Reset chat appearance'),
        description: translate(
          'settings.appearance.chat.resetDescription',
          'Restore the defaults above.'
        )
      }
    }) satisfies Record<string, SettingsSearchEntry>
)

export function getChatAppearanceEntriesByKey(shortcuts?: { increase: string; decrease: string }) {
  const entries = getChatAppearanceCatalog()
  return {
    ...entries,
    textSize: {
      ...entries.textSize,
      description: translate(
        'settings.appearance.chat.textSizeDescription',
        'Messages, tool activity and the message box. {{increase}} / {{decrease}} in a chat change this too.',
        {
          increase: shortcuts?.increase ?? formatPrimaryShortcutLabel('zoom.in'),
          decrease: shortcuts?.decrease ?? formatPrimaryShortcutLabel('zoom.out')
        }
      )
    }
  }
}

export function getChatAppearanceSearchEntries(): SettingsSearchEntry[] {
  return [
    {
      title: translate('auto.components.settings.Settings.2b4474780a', 'Appearance')
    },
    ...Object.values(getChatAppearanceEntriesByKey())
  ]
}

export function getChatWidthOptions() {
  return [
    {
      value: 'comfortable',
      label: translate('settings.appearance.chat.comfortable', 'Comfortable')
    },
    { value: 'wide', label: translate('settings.appearance.chat.wide', 'Wide') },
    { value: 'full', label: translate('settings.appearance.chat.full', 'Full') }
  ] as const
}
