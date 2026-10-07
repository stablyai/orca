import { translate } from '@/i18n/i18n'
import type { ClosedEditorTabSnapshot } from '../types/open-file'

/** Why the record blocked the parked draft, in the wording the user needs to act on. */
export type RecoveredDraftBlockReason = 'unsaved-rival' | 'read-only' | 'other-owner'

/** The parked draft stayed parked; name the document and what unblocks it. */
export function recoveredDraftBlockedMessage(
  reason: RecoveredDraftBlockReason,
  file: Pick<ClosedEditorTabSnapshot, 'filePath' | 'relativePath'>
): string {
  const path = file.relativePath || file.filePath
  if (reason === 'other-owner') {
    return translate(
      'auto.store.slices.editor.parkedDraftBlockedByOtherOwner',
      '{{path}} is open on another host. Close that tab, then reopen to recover the parked draft.',
      { path }
    )
  }
  return reason === 'read-only'
    ? translate(
        'auto.store.slices.editor.parkedDraftBlockedByReadOnlyTab',
        '{{path}} is open read-only. Close it, then reopen to recover the parked draft.',
        { path }
      )
    : translate(
        'auto.store.slices.editor.parkedDraftBlockedByUnsavedChanges',
        '{{path}} is open with unsaved changes. Save or close it, then reopen to recover the parked draft.',
        { path }
      )
}
