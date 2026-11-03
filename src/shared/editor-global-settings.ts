import type { EditorKeybindingsPreset } from './editor-keybindings'

export type EditorGlobalSettings = {
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  editorMinimapEnabled: boolean
  /** Defaults on for profiles saved before file-editor wrapping became configurable. */
  editorWordWrap?: boolean
  /** Writable file-editor keys. Missing or unknown values stay on Default. */
  editorKeybindings?: EditorKeybindingsPreset
}
