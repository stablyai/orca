import type { SettingsSearchEntry } from './settings-search'

export const ICON_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Icon Theme',
    description: 'Choose which icon set the file explorer uses.',
    keywords: ['icon', 'icons', 'theme', 'material', 'lucide', 'file explorer']
  },
  {
    title: 'Size',
    description: 'Size of icons and text in the file explorer.',
    keywords: ['icon', 'size', 'font', 'text', 'file explorer', 'px']
  }
]

export const PREVIEW_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Preview',
    description: 'Live preview of the active file explorer theme.',
    keywords: ['preview', 'file explorer']
  }
]

export const FILE_EXPLORER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...ICON_ENTRIES,
  ...PREVIEW_ENTRIES
]
