import { translate } from '@/i18n/i18n'

export function formatVanishedSelectionNotice(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.cleanup.browse.selectionVanishedOne',
        '1 selected workspace no longer exists.'
      )
    : translate(
        'components.workspace.cleanup.browse.selectionVanished',
        '{{value0}} selected workspaces no longer exist.',
        { value0: count }
      )
}

/** Explains selection removed when a facet filter hides rows. */
export function formatWithheldSelectionNotice(count: number): string {
  return count === 1
    ? translate(
        'components.workspace.cleanup.browse.selectionWithheldOne',
        '1 selected workspace is hidden by the current filters and was deselected.'
      )
    : translate(
        'components.workspace.cleanup.browse.selectionWithheld',
        '{{value0}} selected workspaces are hidden by the current filters and were deselected.',
        { value0: count }
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
