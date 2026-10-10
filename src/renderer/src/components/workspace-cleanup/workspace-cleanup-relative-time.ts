import { translate } from '@/i18n/i18n'

/** Compact "how long ago" label for cleanup rows; 0 means Orca never recorded it. */
export function formatWorkspaceCleanupRelativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) {
    return translate('components.workspace.cleanup.relativeTime.never', 'Never')
  }
  const deltaMs = now - timestamp
  if (deltaMs < 60_000) {
    return translate('components.workspace.cleanup.relativeTime.justNow', 'Just now')
  }
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) {
    return translate('components.workspace.cleanup.relativeTime.minutesAgo', '{{value0}}m ago', {
      value0: minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return translate('components.workspace.cleanup.relativeTime.hoursAgo', '{{value0}}h ago', {
      value0: hours
    })
  }
  return translate('components.workspace.cleanup.relativeTime.daysAgo', '{{value0}}d ago', {
    value0: Math.floor(hours / 24)
  })
}
