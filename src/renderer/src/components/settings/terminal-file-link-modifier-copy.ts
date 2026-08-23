import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

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

export function getTerminalFileLinkModifierSearchKeywords(platform: { isMac: boolean }): string[] {
  return [
    ...translateSearchKeyword('auto.components.settings.terminal.search.39ea7c0d28', 'terminal'),
    ...translateSearchKeyword('auto.components.settings.terminal.search.file', 'file'),
    ...translateSearchKeyword('auto.components.settings.terminal.search.link', 'link'),
    ...translateSearchKeyword('auto.components.settings.terminal.search.shift', 'shift'),
    ...translateSearchKeyword('auto.components.settings.terminal.search.modifier', 'modifier'),
    'invert',
    'swap',
    'default app',
    'finder',
    platform.isMac ? 'cmd' : 'ctrl',
    platform.isMac ? 'ctrl' : 'cmd'
  ]
}
