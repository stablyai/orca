// @protected-copy scope=file
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Compact "how long ago" label for cleanup rows; 0 means Orca never recorded it. */
export function formatWorkspaceCleanupRelativeTime(
  timestamp: number,
  now = Date.now(),
  t: Translate = translate
): string {
  if (!timestamp) {
    return t('components.workspace.cleanup.relativeTime.never', 'Never')
  }
  const deltaMs = now - timestamp
  if (deltaMs < 60_000) {
    return t('components.workspace.cleanup.relativeTime.justNow', 'Just now')
  }
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) {
    return t('components.workspace.cleanup.relativeTime.minutesAgo', '{{value0}}m ago', {
      value0: minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return t('components.workspace.cleanup.relativeTime.hoursAgo', '{{value0}}h ago', {
      value0: hours
    })
  }
  return t('components.workspace.cleanup.relativeTime.daysAgo', '{{value0}}d ago', {
    value0: Math.floor(hours / 24)
  })
}
