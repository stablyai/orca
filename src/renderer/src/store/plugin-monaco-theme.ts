import { create } from 'zustand'
import type { PluginMonacoTheme } from '@/lib/plugin-monaco-theme'

/** The editor theme derived from the active plugin app theme; null keeps Monaco's built-in. */
export const usePluginMonacoThemeStore = create<{ theme: PluginMonacoTheme | null }>()(() => ({
  theme: null
}))
