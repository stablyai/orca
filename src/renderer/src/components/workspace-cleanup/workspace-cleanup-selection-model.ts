import { translate } from '@/i18n/i18n'

export function formatVanishedSelectionNotice(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.cleanup.browse.selectionVanishedCount_one',
        '{{count}} selected workspace no longer exists.',
        { count }
      )
    : translate(
        'components.workspace.cleanup.browse.selectionVanishedCount_other',
        '{{count}} selected workspaces no longer exist.',
        { count }
      )
}

export function formatWithheldSelectionNotice(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.cleanup.browse.selectionWithheldCount_one',
        '{{count}} selected workspace is hidden by the current filters and was deselected.',
        { count }
      )
    : translate(
        'components.workspace.cleanup.browse.selectionWithheldCount_other',
        '{{count}} selected workspaces are hidden by the current filters and were deselected.',
        { count }
      )
}

export function toggleSetMember(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}
