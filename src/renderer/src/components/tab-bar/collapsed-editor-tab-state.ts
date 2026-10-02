import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { OpenFile } from '../../store/slices/editor'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'

export type CollapsedEditorTabState = {
  /** Tint for the state dot; null keeps the neutral unsaved-changes dot. */
  dotColor: string | null
  /** Null when the tab has no state to report. */
  stateLabel: string | null
  /** Tooltip and accessible name, e.g. "README.md (M, unsaved)". */
  title: string
}

/**
 * Collapsed to an icon, a pinned editor tab drops the label that carried its git status letter,
 * external-mutation badge, strikethrough and status color. This recovers that state as one tinted
 * dot plus text, so a modified or deleted file still reads as one at a glance and through AT.
 *
 * Unsaved changes are additive rather than ranked: the expanded tab shows the dirty dot alongside
 * the status badge, so collapsing must not let one signal shadow the other.
 */
export function getCollapsedEditorTabState({
  file,
  tabStatus,
  tabLabel
}: {
  file: Pick<OpenFile, 'isDirty' | 'externalMutation'>
  tabStatus: GitFileStatus | null
  tabLabel: string
}): CollapsedEditorTabState {
  const parts: string[] = []
  let dotColor: string | null = null

  // A deleted or renamed file is gone from its path, which outranks whatever git last saw there —
  // the expanded tab makes the same call by striking the label through instead of showing status.
  if (file.externalMutation === 'deleted' || file.externalMutation === 'renamed') {
    parts.push(file.externalMutation)
  } else if (tabStatus) {
    parts.push(STATUS_LABELS[tabStatus])
    dotColor = STATUS_COLORS[tabStatus]
  }
  if (file.isDirty) {
    parts.push('unsaved')
  }

  const stateLabel = parts.length > 0 ? parts.join(', ') : null
  return { dotColor, stateLabel, title: stateLabel ? `${tabLabel} (${stateLabel})` : tabLabel }
}
