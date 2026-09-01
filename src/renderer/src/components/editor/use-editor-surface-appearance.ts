import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  resolveEditorSurfaceAppearance,
  type EditorSurfaceAppearance
} from '@/lib/terminal-editor-palette'
import { useSystemPrefersDark } from '../terminal-pane/use-system-prefers-dark'

/** Light/dark flag (and terminal palette, when the chrome follows it) for markdown, mermaid, and viewer panes. */
export function useEditorSurfaceAppearance(): EditorSurfaceAppearance {
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  return useMemo(
    () => resolveEditorSurfaceAppearance(settings, systemPrefersDark),
    [settings, systemPrefersDark]
  )
}
