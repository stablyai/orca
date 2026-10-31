import type { CSSProperties } from 'react'
import type { editor } from 'monaco-editor'
import type { EditorTypographySettings } from '../../../shared/editor-typography-settings-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizeFontWeight } from '../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../shared/terminal-ligatures'
import { computeDiffEditorFontSize, computeEditorFontSize } from '@/lib/editor-font-zoom'
import { buildFontFamily } from '@/lib/monospace-font-family'

export const EDITOR_FONT_SIZE_MIN = 10
export const EDITOR_FONT_SIZE_MAX = 24
export const EDITOR_LINE_HEIGHT_MIN = 1
export const EDITOR_LINE_HEIGHT_MAX = 3
/** At or above this a line height is read as pixels, matching Monaco's own `lineHeight` rule. */
const EDITOR_LINE_HEIGHT_PIXEL_THRESHOLD = 8
export const EDITOR_REGULAR_FONT_WEIGHT = 400
const FALLBACK_EDITOR_FONT_SIZE = 13
/** Marks DOM code surfaces so opt-in font smoothing reaches them like Monaco. */
export const EDITOR_TYPOGRAPHY_SURFACE_CLASS = 'editor-typography-surface'

export type EditorLigaturesMode = NonNullable<EditorTypographySettings['editorLigatures']>
/** Editor keys plus the terminal values an unset editor key follows. */
export type EditorTypographyInputs = EditorTypographySettings &
  Partial<Pick<GlobalSettings, 'terminalFontFamily' | 'terminalFontSize'>>

/** Diff gutters render slightly smaller than file editors. */
export type EditorTypographySurface = 'editor' | 'diff'

/** Single source for code-surface typography so Monaco sites and DOM excerpts cannot drift. */
export type EditorTypography = {
  /** Monaco appends its own fallbacks; DOM surfaces use `cssFontFamily`. */
  fontFamily: string
  cssFontFamily: string
  fontSize: number
  fontWeight: string
  /** Pixels; 0 keeps Monaco's automatic spacing. */
  lineHeight: number
  fontLigatures: boolean
}

/**
 * Why: the editor font is opt-in and defaults to empty, so an unset value must
 * keep falling back to the terminal font exactly as before the setting existed.
 */
export function resolveEditorFontFamily(settings?: EditorTypographyInputs | null): string {
  return settings?.editorFontFamily?.trim() || settings?.terminalFontFamily || 'monospace'
}

/** Monaco adds fallback fonts itself; other code surfaces need an explicit stack or unknown names can fall back to serif. */
export function resolveEditorFontStack(settings?: EditorTypographyInputs | null): string {
  const family = settings?.editorFontFamily?.trim() || settings?.terminalFontFamily?.trim() || ''
  // A comma list is already a CSS stack; quoting it would make it one unknown family name.
  return family.includes(',') ? family : buildFontFamily(family)
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Base size before editor zoom; hand-edited settings can hold non-numbers, so validate before use. */
export function resolveEditorBaseFontSize(settings?: EditorTypographyInputs | null): number {
  const editorFontSize = settings?.editorFontSize
  if (isPositiveNumber(editorFontSize)) {
    return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, editorFontSize))
  }
  const terminalFontSize = settings?.terminalFontSize
  return isPositiveNumber(terminalFontSize) ? terminalFontSize : FALLBACK_EDITOR_FONT_SIZE
}

/**
 * Multiplier of the base size, or undefined for automatic spacing. Why accept pixels and 0:
 * code editors commonly take `22` as pixels and `0` as automatic, so neither may become 3x or 1x.
 */
function resolveEditorLineHeightRatio(value: unknown, baseFontSize: number): number | undefined {
  if (!isPositiveNumber(value)) {
    return undefined
  }
  const ratio = value >= EDITOR_LINE_HEIGHT_PIXEL_THRESHOLD ? value / baseFontSize : value
  return Math.min(EDITOR_LINE_HEIGHT_MAX, Math.max(EDITOR_LINE_HEIGHT_MIN, ratio))
}

export function resolveEditorTypography(
  settings: EditorTypographyInputs | null | undefined,
  zoomLevel: number,
  surface: EditorTypographySurface = 'editor'
): EditorTypography {
  const baseFontSize = resolveEditorBaseFontSize(settings)
  const fontSize =
    surface === 'diff'
      ? computeDiffEditorFontSize(baseFontSize, zoomLevel)
      : computeEditorFontSize(baseFontSize, zoomLevel)
  const fontFamily = resolveEditorFontFamily(settings)
  const lineHeightRatio = resolveEditorLineHeightRatio(settings?.editorLineHeight, baseFontSize)
  return {
    fontFamily,
    cssFontFamily: resolveEditorFontStack(settings),
    fontSize,
    fontWeight: isPositiveNumber(settings?.editorFontWeight)
      ? String(normalizeFontWeight(settings.editorFontWeight, EDITOR_REGULAR_FONT_WEIGHT))
      : 'normal',
    lineHeight: lineHeightRatio ? Math.round(fontSize * lineHeightRatio) : 0,
    fontLigatures: resolveTerminalLigaturesEnabled(resolveEditorLigaturesMode(settings), fontFamily)
  }
}

/** Anything but an explicit on/auto is off: Monaco never rendered ligatures before this setting existed. */
export function resolveEditorLigaturesMode(
  settings?: EditorTypographyInputs | null
): EditorLigaturesMode {
  const mode = settings?.editorLigatures
  return mode === 'on' || mode === 'auto' ? mode : 'off'
}

export type MonacoTypographyOptions = Required<
  Pick<
    editor.IEditorOptions,
    'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'fontLigatures'
  >
>

export function monacoTypographyOptions(typography: EditorTypography): MonacoTypographyOptions {
  return {
    fontFamily: typography.fontFamily,
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures
  }
}

/** DOM code surfaces mirror Monaco: it disables liga/calt unless ligatures are on. */
export function editorTypographyTextStyle(typography: EditorTypography): CSSProperties {
  return {
    fontFamily: typography.cssFontFamily,
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    ...(typography.lineHeight ? { lineHeight: `${typography.lineHeight}px` } : {}),
    fontFeatureSettings: typography.fontLigatures
      ? '"liga" on, "calt" on'
      : '"liga" off, "calt" off'
  }
}
