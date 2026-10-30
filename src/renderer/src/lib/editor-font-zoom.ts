import { buildFontFamily } from '@/lib/monospace-font-family'

const EDITOR_FONT_ZOOM_MIN = -6
const EDITOR_FONT_ZOOM_MAX = 18
const EDITOR_FONT_ZOOM_STEP = 1

export type EditorZoomDirection = 'in' | 'out' | 'reset'

export function clampEditorFontZoomLevel(level: number): number {
  return Math.max(EDITOR_FONT_ZOOM_MIN, Math.min(EDITOR_FONT_ZOOM_MAX, level))
}

export function nextEditorFontZoomLevel(current: number, direction: EditorZoomDirection): number {
  if (direction === 'reset') {
    return 0
  }
  if (direction === 'in') {
    return clampEditorFontZoomLevel(current + EDITOR_FONT_ZOOM_STEP)
  }
  return clampEditorFontZoomLevel(current - EDITOR_FONT_ZOOM_STEP)
}

export function computeEditorFontSize(baseFontSize: number, zoomLevel: number): number {
  // Clamp after zoom so editor/markdown surfaces stay readable regardless of base size.
  return Math.max(8, Math.min(32, baseFontSize + zoomLevel))
}

export function computeDiffEditorFontSize(baseFontSize: number, zoomLevel: number): number {
  // Dense diff gutters/decorations need smaller defaults than terminal text to fit app chrome.
  return computeEditorFontSize(baseFontSize - 0.5, zoomLevel)
}

export type EditorFontFamilySettings = {
  editorFontFamily?: string
  terminalFontFamily?: string
}

/**
 * Why: the editor font is opt-in and defaults to empty, so an unset value must
 * keep falling back to the terminal font exactly as before the setting existed.
 */
export function resolveEditorFontFamily(settings?: EditorFontFamilySettings | null): string {
  return settings?.editorFontFamily?.trim() || settings?.terminalFontFamily || 'monospace'
}

/** Monaco adds fallback fonts itself; other code surfaces need an explicit stack or unknown names can fall back to serif. */
export function resolveEditorFontStack(settings?: EditorFontFamilySettings | null): string {
  const family = settings?.editorFontFamily?.trim() || settings?.terminalFontFamily?.trim() || ''
  // A comma list is already a CSS stack; quoting it would make it one unknown family name.
  return family.includes(',') ? family : buildFontFamily(family)
}
