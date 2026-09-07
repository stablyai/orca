import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { requestEditorFileSave, type EditorSaveFileTarget } from './editor-autosave'

export async function attemptEditorFileSave(target: EditorSaveFileTarget): Promise<boolean> {
  try {
    await requestEditorFileSave(target)
    return true
  } catch (error) {
    // Why: shortcut handlers need a non-throwing result, while dependent actions must not treat a rejected write as success.
    console.error('[editor] file save failed', error)
    toast.error(
      translate(
        'auto.components.editor.editor.save.failure.notice.8c59ce5075',
        'Failed to save the file. Please try again.'
      )
    )
    return false
  }
}
