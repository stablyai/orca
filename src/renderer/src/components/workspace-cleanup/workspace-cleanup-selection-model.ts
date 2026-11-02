import { translate } from '@/i18n/i18n'

export function formatVanishedSelectionNotice(count: number): string {
  return translate(
    'components.workspace.cleanup.browse.selectionVanishedCount',
    '{{count}} selected workspaces no longer exist.',
    { count, defaultValue_one: '{{count}} selected workspace no longer exists.' }
  )
}

export function formatWithheldSelectionNotice(count: number): string {
  return translate(
    'components.workspace.cleanup.browse.selectionWithheldCount',
    '{{count}} selected workspaces are hidden by the current filters and were deselected.',
    {
      count,
      defaultValue_one:
        '{{count}} selected workspace is hidden by the current filters and was deselected.'
    }
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
