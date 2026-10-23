import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { requestEditorFileSave, type EditorSaveFileTarget } from './editor-autosave'
import {
  EDITOR_NOT_UTF8_SAVE_MESSAGE,
  EDITOR_STALE_SAVE_MESSAGE
} from './editor-save-disk-precondition'

/** Asks before an explicit save rewrites a non-UTF-8 file as UTF-8, which can't be undone. */
export function confirmEditorUtf8Conversion(
  confirm: ConfirmationDialogContextValue,
  filePath: string
): Promise<boolean> {
  return confirm({
    title: translate(
      'auto.components.editor.editor.save.notUtf8.confirm.title',
      'Save {{name}} as UTF-8?',
      { name: basename(filePath) }
    ),
    description: translate(
      'auto.components.editor.editor.save.notUtf8.confirm.description',
      "This file isn't UTF-8 text. Saving it as UTF-8 replaces any characters that aren't valid UTF-8 with �, and the original bytes can't be recovered."
    ),
    confirmLabel: translate(
      'auto.components.editor.editor.save.notUtf8.confirm.action',
      'Save as UTF-8'
    ),
    confirmVariant: 'destructive'
  })
}

export async function attemptEditorFileSave(
  target: EditorSaveFileTarget,
  confirmUtf8Conversion?: () => Promise<boolean>
): Promise<boolean> {
  try {
    await requestEditorFileSave(target)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === EDITOR_NOT_UTF8_SAVE_MESSAGE &&
      !target.convertToUtf8 &&
      confirmUtf8Conversion
    ) {
      return (await confirmUtf8Conversion())
        ? attemptEditorFileSave({ ...target, convertToUtf8: true })
        : false
    }
    // Why: shortcut handlers need a non-throwing result, while dependent actions must not treat a rejected write as success.
    console.error('[editor] file save failed', error)
    toast.error(
      error instanceof Error && error.message === EDITOR_STALE_SAVE_MESSAGE
        ? translate('auto.components.editor.editor.save.stale.notice', EDITOR_STALE_SAVE_MESSAGE)
        : error instanceof Error && error.message === EDITOR_NOT_UTF8_SAVE_MESSAGE
          ? translate(
              'auto.components.editor.editor.save.notUtf8.refused',
              EDITOR_NOT_UTF8_SAVE_MESSAGE
            )
          : translate(
              'auto.components.editor.editor.save.failure.notice.8c59ce5075',
              'Failed to save the file. Please try again.'
            )
    )
    return false
  }
}
