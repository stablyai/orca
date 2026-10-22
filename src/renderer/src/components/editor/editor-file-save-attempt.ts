import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { requestEditorFileSave, type EditorSaveFileTarget } from './editor-autosave'
import { EDITOR_STALE_SAVE_MESSAGE } from './editor-save-disk-precondition'

export async function attemptEditorFileSave(target: EditorSaveFileTarget): Promise<boolean> {
  try {
    await requestEditorFileSave(target)
    return true
  } catch (error) {
    // Why: shortcut handlers need a non-throwing result, while dependent actions must not treat a rejected write as success.
    console.error('[editor] file save failed', error)
    toast.error(
      error instanceof Error && error.message === EDITOR_STALE_SAVE_MESSAGE
        ? translate('auto.components.editor.editor.save.stale.notice', EDITOR_STALE_SAVE_MESSAGE)
        : translate(
            'auto.components.editor.editor.save.failure.notice.8c59ce5075',
            'Failed to save the file. Please try again.'
          )
    )
    return false
  }
}
