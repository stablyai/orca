import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  resolveEditorTypography,
  type EditorTypography,
  type EditorTypographySurface
} from '@/lib/editor-typography'

type ResolvedEditorTypography = {
  settings: AppState['settings']
  zoomLevel: number
  typography: EditorTypography
}

// Why: every mounted editor runs this selector on every store write; resolve once per settings write instead.
const resolvedBySurface = new Map<EditorTypographySurface, ResolvedEditorTypography>()

function selectEditorTypography(
  state: AppState,
  surface: EditorTypographySurface
): EditorTypography {
  const cached = resolvedBySurface.get(surface)
  if (
    cached &&
    cached.settings === state.settings &&
    cached.zoomLevel === state.editorFontZoomLevel
  ) {
    return cached.typography
  }
  const typography = resolveEditorTypography(state.settings, state.editorFontZoomLevel, surface)
  resolvedBySurface.set(surface, {
    settings: state.settings,
    zoomLevel: state.editorFontZoomLevel,
    typography
  })
  return typography
}

/** Shallow selection of the resolved values keeps the result stable unless the effective typography changes. */
export function useEditorTypography(surface: EditorTypographySurface = 'editor'): EditorTypography {
  return useAppStore(useShallow((s) => selectEditorTypography(s, surface)))
}
