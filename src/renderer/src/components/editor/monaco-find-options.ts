import type { editor } from 'monaco-editor'

export const monacoFindOptions = {
  addExtraSpaceOnTop: false,
  autoFindInSelection: 'never',
  seedSearchStringFromSelection: 'selection'
} satisfies editor.IEditorFindOptions
