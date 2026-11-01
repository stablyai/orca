import { translate } from '@/i18n/i18n'
import { filePreviewForPath } from '../../../../../shared/file-preview-kind'
import { fileList } from './plugin-contribution-file-list'

/** Says when an editor opens files Orca would otherwise show in its own image, PDF or media viewer. */
export function customEditorTakeover(editor: {
  extensions: readonly string[]
  priority?: 'default' | 'option'
}): string | null {
  if (editor.priority === 'option') {
    return null
  }
  const viewed = editor.extensions.filter(
    (extension) => filePreviewForPath(`file${extension}`) !== null
  )
  if (viewed.length === 0) {
    return null
  }
  const value0 = fileList(viewed, [])
  return editor.priority === 'default'
    ? translate(
        'auto.components.settings.pluginContributions.editorReplacesViewer',
        'Opens {{value0}} instead of Orca’s viewer',
        { value0 }
      )
    : translate(
        'auto.components.settings.pluginContributions.editorMayReplaceViewer',
        'May open {{value0}} instead of Orca’s viewer',
        { value0 }
      )
}
