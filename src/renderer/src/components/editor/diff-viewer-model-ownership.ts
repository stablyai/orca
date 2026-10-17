import type { editor } from 'monaco-editor'
import { editorModelRegistry } from '@/lib/editor-model-registry'

type ModelOwnerEditor = {
  getModel(): editor.ITextModel | null
  onDidChangeModel(listener: () => void): { dispose(): void }
}

export function retainDiffViewerModelOwner(
  diffEditor: {
    getOriginalEditor(): ModelOwnerEditor
    getModifiedEditor(): ModelOwnerEditor
  },
  fileId: string,
  bridge = editorModelRegistry
): { dispose(): void } {
  const original = diffEditor.getOriginalEditor()
  const modified = diffEditor.getModifiedEditor()
  const retain = (): void => {
    const models = [original.getModel(), modified.getModel()].filter(
      (model): model is editor.ITextModel => model !== null
    )
    bridge.retainDiffModels(fileId, models)
  }
  retain()
  const originalListener = original.onDidChangeModel(retain)
  const modifiedListener = modified.onDidChangeModel(retain)
  return {
    dispose(): void {
      originalListener.dispose()
      modifiedListener.dispose()
    }
  }
}
