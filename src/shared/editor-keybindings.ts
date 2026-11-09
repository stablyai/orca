export type EditorKeybindingsPreset = 'default' | 'vim'

export function resolveEditorKeybindings(value: string | undefined): EditorKeybindingsPreset {
  return value === 'vim' ? 'vim' : 'default'
}
