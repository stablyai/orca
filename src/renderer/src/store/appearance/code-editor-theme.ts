import { create } from 'zustand'
import type { CodeEditorTheme } from '@/lib/code-editor-theme'

/** The theme every Monaco surface uses; resolved from the editor and app theme settings. */
export const useCodeEditorThemeStore = create<CodeEditorTheme>()(() => ({
  monaco: null,
  override: null
}))
