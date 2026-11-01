import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export const getWindowTitleEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'settings.appearance.windowTitle.title',
      'Show project, branch, and session in window title'
    ),
    description: translate(
      'settings.appearance.windowTitle.description',
      'Shows the active project, branch, and focused session in the window title so time trackers like ActivityWatch, Timing, WakaTime, and RescueTime can attribute your time. Screen recorders and apps with accessibility access can read window titles.'
    ),
    // Product and tracker names are not localized, so these stay English.
    keywords: [
      'window title',
      'title format',
      'title template',
      'time tracking',
      'time tracker',
      'activitywatch',
      'timing',
      'wakatime',
      'rescuetime',
      'project',
      'branch',
      'session',
      'separator'
    ]
  }
])
