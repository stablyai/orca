import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from './settings-search'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'

export function chatTerminalControlledHint(): string {
  return translate('settings.appearance.chat.terminalControlledHint', 'Set by terminal interface.')
}

export function chatTerminalControlledTooltip(): string {
  return translate(
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
    { title: translate('auto.components.settings.Settings.2b4474780a', 'Appearance') },
    ...Object.values(getChatAppearanceEntriesByKey()),
    ...getChatContrastSearchEntries()
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
