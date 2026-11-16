import type { CSSProperties } from 'react'
import { DEFAULT_VIRTUAL_FILE_METRICS, type FileDiffOptions, type ThemesType } from '@pierre/diffs'
import type { CreatePatchOptionsNonabortable } from 'diff'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  resolveEditorTypography,
  type EditorTypography
} from '../../../../../shared/editor/editor-typography'
import { PIERRE_SEARCH_CSS } from './pierre-diff-search-view'

/**
 * `light-plus` / `dark-plus` are the VS Code default themes that Monaco's
 * `vs` / `vs-dark` mirror, so swapping renderers keeps syntax colors stable.
 */
export const PIERRE_DIFF_THEMES: ThemesType = { light: 'light-plus', dark: 'dark-plus' }

/**
 * Pierre pushes its gutter "+" right with `margin-right: calc(-1lh + 1ch)`,
 * which overlaps the line-number column by ~14px. There is no CSS variable for
 * it, so this is the narrow, data-attribute-only override Pierre's styling docs
 * sanction — keeping the add-note affordance in the glyph margin like Monaco's.
 */
const PIERRE_GUTTER_BUTTON_CSS = '[data-utility-button] { margin-right: 0; }'
const PIERRE_SELECTION_CSS =
  ':host { --diffs-editor-selection-bg: var(--orca-diff-selection-bg); }' +
  ':host(:not(:focus-within)) { --diffs-editor-selection-bg: var(--orca-diff-inactive-selection-bg); }' +
  '[data-code]:not(:has([contenteditable])) ::selection { background-color: var(--diffs-editor-selection-bg); }'

/** Every field is optional: callers pass partial settings while the store hydrates. */
export type PierreDiffSettings = Partial<
  Pick<
    GlobalSettings,
    | 'theme'
    | 'diffWordWrap'
    | 'diffShowWhitespace'
    | 'terminalFontSize'
    | 'editorFontFamily'
    | 'terminalFontFamily'
    | 'editorFontSize'
    | 'editorFontWeight'
    | 'editorLineHeight'
    | 'editorLigatures'
  >
>

/**
 * jsdiff options used when Pierre derives a diff from raw file contents.
 * Mirrors Monaco's `ignoreTrimWhitespace`: showing whitespace means we must
 * stop collapsing indentation-only changes.
 */
export function buildPierreParseDiffOptions(
  diffShowWhitespace: boolean | undefined
): CreatePatchOptionsNonabortable {
  return { ignoreWhitespace: diffShowWhitespace !== true }
}

export function buildPierreDiffOptions<LAnnotation>({
  settings,
  sideBySide,
  collapsed,
  collapseUnchanged
}: {
  settings?: PierreDiffSettings | null
  sideBySide: boolean
  collapsed?: boolean
  collapseUnchanged: boolean
}): FileDiffOptions<LAnnotation, undefined> {
  return {
    diffStyle: sideBySide ? 'split' : 'unified',
    // Why: the worker pool owns `theme` while it is attached, but any
    // main-thread render (pool warming up, or a worker-less fallback) reads it
    // from here — without it Pierre asks Shiki for its unregistered default
    // `pierre-dark` and the render throws instead of painting.
    theme: PIERRE_DIFF_THEMES,
    unsafeCSS: PIERRE_GUTTER_BUTTON_CSS + PIERRE_SEARCH_CSS + PIERRE_SELECTION_CSS,
    themeType: settings?.theme ?? 'system',
    overflow: settings?.diffWordWrap ? 'wrap' : 'scroll',
    parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace),
    expandUnchanged: !collapseUnchanged,
    collapsed,
    // Why: our own DiffSectionHeader / DiffViewer chrome already renders the file row.
    disableFileHeader: true,
    // Drafts are persisted on each edit; the next mount computes hunks in a worker.
    recomputeDiffOnCleanup: false,
    enableLineSelection: true,
    lineHoverHighlight: 'both'
  }
}

/** Pierre reads typography from CSS variables rather than component options. */
export function buildPierreDiffStyle(
  settings: PierreDiffSettings | null | undefined,
  editorFontZoomLevel: number,
  typography: EditorTypography = resolveEditorTypography(settings, editorFontZoomLevel, 'diff')
): CSSProperties & Record<`--diffs-${string}`, string> {
  const { fontSize } = typography
  return {
    // Why: Pierre's own fallback only applies when the variable is absent, so a
    // configured-but-uninstalled font (e.g. "SF Mono" on a Mac without it) would
    // drop all the way to the default serif face. Reuse the terminal's
    // cross-platform monospace chain, which always ends in `monospace`.
    '--diffs-font-family': typography.cssFontFamily,
    '--diffs-font-features': typography.fontLigatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
    fontWeight: typography.fontWeight,
    fontVariantLigatures: typography.fontLigatures ? 'normal' : 'none',
    '--diffs-font-size': `${fontSize}px`,
    '--diffs-line-height': `${buildPierreDiffMetrics(settings, editorFontZoomLevel, typography).lineHeight}px`
  }
}

export function buildPierreDiffMetrics(
  settings: PierreDiffSettings | null | undefined,
  editorFontZoomLevel: number,
  typography: EditorTypography = resolveEditorTypography(settings, editorFontZoomLevel, 'diff')
) {
  const { fontSize } = typography
  return {
    ...DEFAULT_VIRTUAL_FILE_METRICS,
    lineHeight: typography.lineHeight || Math.round(fontSize * 1.5)
  }
}
