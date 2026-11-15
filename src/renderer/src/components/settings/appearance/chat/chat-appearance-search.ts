import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../../search/settings-search-keywords'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'

export function chatTerminalControlledHint(t: Translate = translate): string {
  return t('settings.appearance.chat.terminalControlledHint', 'Set by terminal interface.')
}

export function chatTerminalControlledTooltip(t: Translate = translate): string {
  return t(
    'settings.appearance.chat.terminalControlledTooltip',
    'Matching your terminal interface. Turn off Match terminal interface to change this.'
  )
}

export const getChatContrastEntriesByKey = createLocalizedCatalog(
  () =>
    ({
      matchTerminalInterface: {
        title: translate(
          'settings.appearance.chat.matchTerminalInterface',
          'Match terminal interface'
        ),
        description: translate(
          'settings.appearance.chat.matchTerminalInterfaceDescription',
          "Use your terminal interface's font and colors for the whole chat. Stays in sync if you change your terminal theme later."
        ),
        targetSectionId: 'chat-match-terminal-interface'
      },
      contrast: {
        title: translate('settings.appearance.chat.contrast', 'Contrast'),
        description: translate(
          'settings.appearance.chat.contrastDescription',
          'How bright chat text is against the background. The right end matches the older, brighter look.'
        ),
        targetSectionId: 'chat-contrast'
      }
    }) satisfies Record<string, SettingsSearchEntry>
)

export function getChatContrastSearchEntries(): SettingsSearchEntry[] {
  return Object.values(getChatContrastEntriesByKey())
}

const getChatAppearanceCatalog = createLocalizedCatalog(
  () =>
    ({
      fontFamily: {
        targetSectionId: 'chat-font-family',
        title: translate('settings.appearance.chat.fontFamily', 'Font family'),
        description: translate(
          'settings.appearance.chat.fontFamilyDescription',
          'Font used for messages, activity, and the message box.'
        ),
        keywords: [
          ...translateSearchKeyword('settings.appearance.chat.title', 'Chat UI'),
          ...translateSearchKeyword('settings.appearance.chat.fontFamily', 'Font family'),
          ...translateSearchKeyword('settings.appearance.chat.fontKeywordTypeface', 'typeface'),
          ...translateSearchKeyword('settings.appearance.chat.fontKeywordTypography', 'typography')
        ]
      },
      textSize: {
        targetSectionId: 'chat-text-size',
        title: translate('settings.appearance.chat.textSize', 'Text size'),
        keywords: [translate('settings.appearance.chat.title', 'Chat UI')]
      },
      codeTextSize: {
        targetSectionId: 'chat-code-text-size',
        title: translate('settings.appearance.chat.codeTextSize', 'Code text size'),
        description: translate(
          'settings.appearance.chat.codeTextSizeDescription',
          'Code blocks, inline code, commands and tool output.'
        ),
        keywords: [translate('settings.appearance.chat.title', 'Chat UI')]
      },
      width: {
        targetSectionId: 'chat-width',
        title: translate('settings.appearance.chat.width', 'Width'),
        description: translate(
          'settings.appearance.chat.widthDescription',
          'How wide messages and the message box can grow in a wide pane.'
        ),
        keywords: [
          translate('settings.appearance.chat.title', 'Chat UI'),
          ...getChatWidthOptions().map((option) => option.label)
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

export function getChatAppearanceEntriesByKey(
  shortcuts?: { increase: string; decrease: string },
  t: Translate = translate
) {
  const entries = getChatAppearanceCatalog()
  return {
    ...entries,
    textSize: {
      ...entries.textSize,
      description: t(
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

export function getChatAppearanceSearchEntries(t: Translate = translate): SettingsSearchEntry[] {
  return [
    { title: t('auto.components.settings.Settings.2b4474780a', 'Appearance') },
    ...Object.values(getChatAppearanceEntriesByKey(undefined, t)),
    ...getChatContrastSearchEntries()
  ]
}

export function getChatWidthOptions(t: Translate = translate) {
  return [
    {
      value: 'comfortable',
      label: t('settings.appearance.chat.comfortable', 'Comfortable')
    },
    { value: 'wide', label: t('settings.appearance.chat.wide', 'Wide') },
    { value: 'full', label: t('settings.appearance.chat.full', 'Full') }
  ] as const
}
