import { normalizeTerminalFontWeight } from '../../../shared/terminal-fonts'
import { getRendererAppPlatform } from './renderer-app-platform'

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
  // Why: Monaco and markdown surfaces become unreadable or visually broken at
  // extreme values. Clamp after applying zoom so all editor-like surfaces stay
  // within the same safe range regardless of their own default base size.
  return Math.max(8, Math.min(32, baseFontSize + zoomLevel))
}

export function computeDiffEditorFontSize(baseFontSize: number, zoomLevel: number): number {
  // Why: diff editors have denser gutters and inline decorations, so matching
  // terminal font size makes review views feel oversized relative to app chrome.
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

/** Same resolution, but keeps the notebook shell's "no font set → inherit UI font" fallback. */
export function resolveEditorFontFamilyOrInherit(
  settings?: EditorFontFamilySettings | null
): string | undefined {
  return settings?.editorFontFamily?.trim() || settings?.terminalFontFamily || undefined
}

export type EditorFontWeightSettings = {
  editorFontWeight?: number
  terminalFontWeight?: number
}

/**
 * Why: the editor weight is opt-in and defaults to 0, so an unset value must keep
 * following the terminal weight exactly as before the setting existed. Returns a
 * string because that is the type Monaco's `fontWeight` editor option accepts.
 */
export function resolveEditorFontWeight(settings?: EditorFontWeightSettings | null): string {
  const editorFontWeight = settings?.editorFontWeight
  const weight =
    typeof editorFontWeight === 'number' && editorFontWeight > 0
      ? editorFontWeight
      : settings?.terminalFontWeight

  return String(normalizeTerminalFontWeight(weight))
}

export type EditorFontSettings = EditorFontFamilySettings & EditorFontWeightSettings

/**
 * Why grouped: every Monaco surface sets family and weight together, so resolving
 * them in one call keeps option objects (and their import lists) from growing a
 * line per typography knob.
 */
export function resolveEditorFontOptions(settings?: EditorFontSettings | null): {
  fontFamily: string
  fontWeight: string
} {
  return {
    fontFamily: resolveEditorFontFamily(settings),
    fontWeight: resolveEditorFontWeight(settings)
  }
}

/** Monaco reads 0 as "compute the line height from the font size". */
export const EDITOR_LINE_HEIGHT_AUTO = 0
export const EDITOR_LINE_HEIGHT_MIN = 1
export const EDITOR_LINE_HEIGHT_MAX = 3
export const EDITOR_LINE_HEIGHT_STEP = 0.1

/**
 * Monaco's GOLDEN_LINE_HEIGHT_RATIO — the multiplier it applies when no line height
 * is set. Mirrored here so the setting can show what "automatic" resolves to.
 */
export function monacoAutomaticLineHeightRatio(
  platform: NodeJS.Platform = getRendererAppPlatform()
): number {
  return platform === 'darwin' ? 1.5 : 1.35
}

export function normalizeEditorLineHeight(lineHeight: number | null | undefined): number {
  if (typeof lineHeight !== 'number' || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    return EDITOR_LINE_HEIGHT_AUTO
  }

  return (
    Math.round(
      Math.min(EDITOR_LINE_HEIGHT_MAX, Math.max(EDITOR_LINE_HEIGHT_MIN, lineHeight)) * 10
    ) / 10
  )
}

/**
 * Why a multiplier rather than pixels: Monaco treats a value between 0 and 8 as a
 * multiple of the font size, which is the same shape as the terminal's Line Height,
 * so the two settings stay comparable while editor zoom keeps working.
 */
export function resolveEditorLineHeight(settings?: { editorLineHeight?: number } | null): number {
  return normalizeEditorLineHeight(settings?.editorLineHeight)
}
