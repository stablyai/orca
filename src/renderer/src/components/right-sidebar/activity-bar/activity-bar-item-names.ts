import type { CheckStatus as CoarseCheckStatus } from '../../../../../shared/github/pull-requests/pull-request-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ActivityBarItem } from './activity-bar-buttons'

export type ActivityItemStatus = CoarseCheckStatus | 'cancelled'

/** The name the item is known by before any status word or shortcut hint is added. */
export function activityItemSpokenName(item: ActivityBarItem): string {
  return item.accessibleTitle ?? item.title
}

/** The tooltip text: the spoken name, then the shortcut hint when the item has one. */
export function activityItemTooltip(item: ActivityBarItem): string {
  const name = activityItemSpokenName(item)
  return item.shortcut ? `${name} (${item.shortcut})` : name
}

/** The item's own status, else the PR checks status for the Checks tab. */
export function activityItemStatus(
  item: ActivityBarItem,
  checksStatus: ActivityItemStatus | null | undefined
): ActivityItemStatus | null {
  return item.statusIndicator ?? (item.id === 'checks' ? (checksStatus ?? null) : null)
}

/** The status word announced after the name; empty when the status needs no word. */
export function activityItemStatusSuffix(
  status: ActivityItemStatus | null | undefined,
  t: Translate = translate
): string {
  if (status === 'failure') {
    return ` — ${t('auto.components.right.sidebar.activityBar.error', 'Error')}`
  }
  if (status === 'cancelled') {
    return ` — ${t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')}`
  }
  return ''
}

export function activityItemAriaLabel(
  item: ActivityBarItem,
  status?: ActivityItemStatus | null,
  t: Translate = translate
): string {
  const titled = activityItemTooltip(item)
  const base = item.count
    ? `${titled}, ${item.countLabel ?? t('bots.upNext.newCount', '{{count}} new', { count: item.count })}`
    : titled
  return `${base}${activityItemStatusSuffix(status, t)}`
}
