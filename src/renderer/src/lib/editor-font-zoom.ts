import { normalizeTerminalLineHeight } from '../../../shared/terminal-line-height-settings'

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

/**
 * Monaco `lineHeight` in px. Inherits terminal Line Height.
 * Unset / invalid values keep the documented default of 1 (`MIN_TERMINAL_LINE_HEIGHT`).
 * Why: omitting this option leaves Monaco on GOLDEN_LINE_HEIGHT_RATIO (1.5 on
 * macOS), so the file view cannot match a terminal at Line Height 1.
 */
export function computeEditorLineHeight(fontSize: number, terminalLineHeight?: number): number {
  return fontSize * normalizeTerminalLineHeight(terminalLineHeight)
}
