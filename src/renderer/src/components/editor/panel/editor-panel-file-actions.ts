import { useAppStore } from '@/store/index'
import { editorViewPlacement } from '@/store/slices/editor/tabs/editor-view-placement'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { getEditorPanelRenderModel } from './editor-panel-render-model'

export function editorPanelFileActions(
  file: OpenFile,
  viewStateId: string | null,
  model: Pick<ReturnType<typeof getEditorPanelRenderModel>, 'openFileState' | 'resolvedLanguage'>
) {
  const handleOpenDiffTargetFile = (preferredMarkdownViewMode?: 'rich'): void => {
    if (!model.openFileState.canOpen) {
      return
    }
    const { openFile, setEditorViewMode, setMarkdownViewMode } = useAppStore.getState()
    const openedFileId = openFile(
      {
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId,
        language: detectLanguage(file.relativePath),
        mode: 'edit'
      },
      editorViewPlacement(useAppStore.getState(), file, viewStateId)
    )
    if (preferredMarkdownViewMode) {
      setEditorViewMode(openedFileId, 'edit')
      setMarkdownViewMode(openedFileId, preferredMarkdownViewMode)
    }
  }
  const handleOpenMarkdownPreview = (): void => {
    useAppStore.getState().openMarkdownPreview(
      {
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId,
        runtimeEnvironmentId: file.runtimeEnvironmentId,
        language: model.resolvedLanguage
      },
      {
        sourceFileId: file.id,
        ...editorViewPlacement(useAppStore.getState(), file, viewStateId)
      }
    )
  }
  return { handleOpenDiffTargetFile, handleOpenMarkdownPreview }
}
