import { translate } from '@/i18n/i18n'

/**
 * Title and description are kept out of the component so the settings-search index
 * can reuse the same strings. Mirrors the Browser pane's link-routing modifier row,
 * except the terminal has no separate routing setting: file links always start in Orca.
 */
export function getTerminalFileLinkModifierTitle(): string {
  return translate(
    'auto.components.settings.TerminalFileLinkModifierSetting.title',
    'Hold Shift to open files in Orca'
  )
}

export function getTerminalFileLinkModifierDescription({ isMac }: { isMac: boolean }): string {
  const chord = isMac ? '⇧⌘' : 'Shift+Ctrl'
  const modifier = isMac ? '⌘' : 'Ctrl'
  return translate(
    'auto.components.settings.TerminalFileLinkModifierSetting.description',
    '{{modifier}}+click opens a terminal file link in Orca and {{chord}}+click uses your default app. When enabled, the two swap.',
    { chord, modifier }
  )
}
