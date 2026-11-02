import type { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { applyCustomEditorToggle } from './view-mode/custom-editor-toggle'
import type { EditorToggleValue } from './view-mode/EditorViewToggle'
import type { getEditorPanelRenderModel } from './editor-panel-render-model'

type StoreState = ReturnType<typeof useAppStore.getState>
type EditorPanelRenderModel = ReturnType<typeof getEditorPanelRenderModel>

export function applyEditorViewToggle({
  next,
  activeFile,
  model,
  setEditorViewMode,
  setMarkdownViewMode,
  handleOpenDiffTargetFile
}: {
  next: EditorToggleValue
  activeFile: OpenFile
  model: EditorPanelRenderModel
  setEditorViewMode: StoreState['setEditorViewMode']
  setMarkdownViewMode: StoreState['setMarkdownViewMode']
  handleOpenDiffTargetFile: (preferredMarkdownViewMode?: 'rich') => void
}): void {
  if (!model.availableEditorToggleModes.includes(next)) {
    return
  }
  const fileId = activeFile.id
  if (activeFile.mode === 'diff' && model.isMarkdown && next === 'rich') {
    handleOpenDiffTargetFile('rich')
    return
  }
  if (next === 'changes') {
    setEditorViewMode(fileId, 'changes')
    return
  }
  setEditorViewMode(fileId, 'edit')
  const markdownMode = applyCustomEditorToggle(fileId, next, model.customEditors.length > 0)
  if (markdownMode) {
    setMarkdownViewMode(fileId, markdownMode)
  }
}
