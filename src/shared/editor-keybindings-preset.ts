/** Keybinding presets the Monaco file editor can run: standard, monaco-vim, or monaco-emacs. */
export const EDITOR_KEYBINDINGS_PRESETS = ['default', 'vim', 'emacs'] as const
export type EditorKeybindingsPreset = (typeof EDITOR_KEYBINDINGS_PRESETS)[number]

export type EditorKeybindingsSettings = {
  /**
   * In-editor keybinding preset for the Monaco file editor. Defaults to `'default'` (standard
   * bindings); `'vim'` enables modal editing via monaco-vim, `'emacs'` enables monaco-emacs.
   */
  editorKeybindings?: EditorKeybindingsPreset
}

/** Narrows a stored preset; profiles written by other builds may hold a value this one retired. */
export function isEditorKeybindingsPreset(value: unknown): value is EditorKeybindingsPreset {
  return EDITOR_KEYBINDINGS_PRESETS.some((preset) => preset === value)
}
