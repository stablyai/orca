export const EDITOR_KEYBINDINGS_PRESETS = ['default', 'vim', 'emacs'] as const
export type EditorKeybindingsPreset = (typeof EDITOR_KEYBINDINGS_PRESETS)[number]

export type EditorKeybindingsSettings = {
  editorKeybindings?: EditorKeybindingsPreset
}

/** Profiles written by other builds may hold a preset this one retired. */
export function isEditorKeybindingsPreset(value: unknown): value is EditorKeybindingsPreset {
  return EDITOR_KEYBINDINGS_PRESETS.some((preset) => preset === value)
}
