import { installMonacoEditorCommandPaletteShortcut } from './editor-shortcuts'

type MonacoCommandPaletteEditor = Parameters<typeof installMonacoEditorCommandPaletteShortcut>[0]

type MonacoDiffCommandPaletteEditor = {
  getOriginalEditor: () => MonacoCommandPaletteEditor
  getModifiedEditor: () => MonacoCommandPaletteEditor
}

export function installMonacoDiffCommandPaletteShortcuts(
  editor: MonacoDiffCommandPaletteEditor
): () => void {
  const cleanupOriginal = installMonacoEditorCommandPaletteShortcut(editor.getOriginalEditor())
  const cleanupModified = installMonacoEditorCommandPaletteShortcut(editor.getModifiedEditor())

  return () => {
    cleanupOriginal()
    cleanupModified()
  }
}
