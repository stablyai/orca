import type { CSSProperties } from 'react'
import type { FileDiffOptions, ThemesType } from '@pierre/diffs'
import type { CreatePatchOptionsNonabortable } from 'diff'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { computeDiffEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'
import { buildFontFamily } from '@/components/terminal-pane/layout-serialization'

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
  /** Monaco only hid unchanged regions in the combined diff, never the file tab. */
  collapseUnchanged: boolean
}): FileDiffOptions<LAnnotation, undefined> {
  return {
    diffStyle: sideBySide ? 'split' : 'unified',
    // Why: the worker pool owns `theme` while it is attached, but any
    // main-thread render (pool warming up, or a worker-less fallback) reads it
    // from here — without it Pierre asks Shiki for its unregistered default
    // `pierre-dark` and the render throws instead of painting.
    theme: PIERRE_DIFF_THEMES,
    unsafeCSS: PIERRE_GUTTER_BUTTON_CSS,
    themeType: settings?.theme ?? 'system',
    overflow: settings?.diffWordWrap ? 'wrap' : 'scroll',
    parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace),
    // Why: replaces Monaco's `hideUnchangedRegions`, which the single-file diff
    // tab never enabled — that surface always showed the whole file.
    expandUnchanged: !collapseUnchanged,
    collapsed,
    // Why: our own DiffSectionHeader / DiffViewer chrome already renders the file row.
    disableFileHeader: true,
    enableLineSelection: true,
    lineHoverHighlight: 'both'
  }
}

/** Pierre reads typography from CSS variables rather than component options. */
export function buildPierreDiffStyle(
  settings: PierreDiffSettings | null | undefined,
  editorFontZoomLevel: number
): CSSProperties {
  const fontSize = computeDiffEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  return {
    // Why: Pierre's own fallback only applies when the variable is absent, so a
    // configured-but-uninstalled font (e.g. "SF Mono" on a Mac without it) would
    // drop all the way to the default serif face. Reuse the terminal's
    // cross-platform monospace chain, which always ends in `monospace`.
    '--diffs-font-family': buildFontFamily(resolveEditorFontFamily(settings)),
    '--diffs-font-size': `${fontSize}px`,
    '--diffs-line-height': `${Math.round(fontSize * 1.5)}px`
  } as CSSProperties
}
