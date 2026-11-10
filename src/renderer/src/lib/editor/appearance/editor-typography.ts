import type { CSSProperties } from 'react'
import type { editor } from 'monaco-editor'
import type { EditorTypography } from '../../../../../shared/editor/editor-typography'

// Why shared: main resolves the same typography for plugins, so the rules live in one place.
export {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_LINE_HEIGHT_MAX,
  EDITOR_LINE_HEIGHT_MIN,
  EDITOR_REGULAR_FONT_WEIGHT,
  resolveEditorBaseFontSize,
  resolveEditorFontFamily,
  resolveEditorFontStack,
  resolveEditorLigaturesMode,
  resolveEditorTypography,
  type EditorLigaturesMode,
  type EditorTypography,
  type EditorTypographyInputs,
  type EditorTypographySurface
} from '../../../../../shared/editor/editor-typography'

/** Marks DOM code surfaces so opt-in font smoothing reaches them like Monaco. */
export const EDITOR_TYPOGRAPHY_SURFACE_CLASS = 'editor-typography-surface'

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
