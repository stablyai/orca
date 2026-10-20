import { translate } from '@/i18n/i18n'
import type { SleepyModeIdleMinutes } from '../../../../shared/sleepy-mode-settings'
import { searchKeywords } from './settings-search-keywords'

export function getSleepyModeTitle(): string {
  return translate('auto.components.settings.sleepy-mode-copy.title', 'Sleepy Mode')
}

export function getSleepyModeDescription(): string {
  return translate(
    'auto.components.settings.sleepy-mode-copy.description',
    'After this long with no input, cover the window with a clock and what the fleet is doing. Any key wakes it. This is a screen cover, not a lock — display sleep still follows Keep computer awake.'
  )
}

export function getSleepyModeStartLabel(): string {
  return translate('auto.components.settings.sleepy-mode-copy.start', 'Start Sleepy Mode')
}

export function getSleepyModeIdleLabel(minutes: SleepyModeIdleMinutes): string {
  if (minutes === 0) {
    return translate('auto.components.settings.sleepy-mode-copy.never', 'Never')
  }
  return translate('auto.components.settings.sleepy-mode-copy.minutes', '{{count}} min', {
    count: minutes
  })
}

export function getSleepyModeSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.sleepy-mode.search.sleepy', fallback: 'sleepy' },
    { key: 'auto.components.settings.sleepy-mode.search.screensaver', fallback: 'screensaver' },
    { key: 'auto.components.settings.sleepy-mode.search.idle', fallback: 'idle' },
    { key: 'auto.components.settings.sleepy-mode.search.clock', fallback: 'clock' },
    { key: 'auto.components.settings.sleepy-mode.search.overnight', fallback: 'overnight' },
    { key: 'auto.components.settings.sleepy-mode.search.privacy', fallback: 'privacy' }
  ])
}
