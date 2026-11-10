import type { CSSProperties } from 'react'
import type { editor } from 'monaco-editor'
import type { EditorTypography } from '../../../../../shared/editor/editor-typography'

import '../../../../../shared/editor/editor-typography'

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
