import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  resolveEditorTypography,
  type EditorTypography,
  type EditorTypographyInputs,
  type EditorTypographySurface
} from '@/lib/editor-typography'

function selectEditorTypographyInputs(state: AppState): EditorTypographyInputs {
  const settings = state.settings
  return {
    editorFontFamily: settings?.editorFontFamily,
    editorFontSize: settings?.editorFontSize,
    editorFontWeight: settings?.editorFontWeight,
    editorLineHeight: settings?.editorLineHeight,
    editorLigatures: settings?.editorLigatures,
    terminalFontFamily: settings?.terminalFontFamily,
    terminalFontSize: settings?.terminalFontSize
  }
}

/** Shallow selection keeps the result stable across unrelated settings writes. */
export function useEditorTypography(surface: EditorTypographySurface = 'editor'): EditorTypography {
  const settings = useAppStore(useShallow(selectEditorTypographyInputs))
  const zoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  return useMemo(
    () => resolveEditorTypography(settings, zoomLevel, surface),
    [settings, zoomLevel, surface]
  )
}
