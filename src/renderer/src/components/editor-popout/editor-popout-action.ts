import { toast } from 'sonner'
import type { AppState } from '@/store'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import type { FileContent } from '@/components/editor/editor-panel-content-types'
import { translate } from '@/i18n/i18n'
import { createEditorPopoutOpenRequest } from './editor-popout-request'

function reportEditorPopoutOpenFailure(cause: unknown): void {
  console.error('[editor] detached editor open failed', cause)
  toast.error(translate('editorPopout.openFailed', 'Could not open this file in a new window.'))
}

export function createEditorPopoutAction({
  getState,
  file,
  fileContent,
  content,
  viewMode,
  showFrontmatter
}: {
  getState: () => AppState
  file: OpenFile
  fileContent: FileContent | undefined
  content: string | undefined
  viewMode: MarkdownViewMode
  showFrontmatter: boolean
}): (() => void) | undefined {
  if (
    file.mode !== 'edit' ||
    file.language !== 'markdown' ||
    file.isUntitled === true ||
    file.readOnly === true ||
    !fileContent ||
    fileContent.isBinary ||
    fileContent.loadError
  ) {
    return undefined
  }
  return () => {
    try {
      const request = createEditorPopoutOpenRequest({
        state: getState(),
        file,
        content: content ?? fileContent.content,
        savedContent: fileContent.content,
        viewMode,
        showFrontmatter
      })
      if (request) {
        void window.api.editorPopout.open(request).catch(reportEditorPopoutOpenFailure)
      }
    } catch (cause) {
      reportEditorPopoutOpenFailure(cause)
    }
  }
}
