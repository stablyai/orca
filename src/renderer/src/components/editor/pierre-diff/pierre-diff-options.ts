import type { CSSProperties } from 'react'
import type { FileDiffOptions } from '@pierre/diffs'
import type { CreatePatchOptionsNonabortable } from 'diff'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { computeDiffEditorFontSize, resolveEditorFontFamily } from '@/lib/editor-font-zoom'

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
  collapsed
}: {
  settings?: PierreDiffSettings | null
  sideBySide: boolean
  collapsed?: boolean
}): FileDiffOptions<LAnnotation> {
  return {
    diffStyle: sideBySide ? 'split' : 'unified',
    themeType: settings?.theme ?? 'system',
    overflow: settings?.diffWordWrap ? 'wrap' : 'scroll',
    parseDiffOptions: buildPierreParseDiffOptions(settings?.diffShowWhitespace),
    // Why: replaces Monaco's `hideUnchangedRegions`; context stays collapsed until expanded.
    expandUnchanged: false,
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
    '--diffs-font-family': resolveEditorFontFamily(settings),
    '--diffs-font-size': `${fontSize}px`,
    '--diffs-line-height': `${Math.round(fontSize * 1.5)}px`
  } as CSSProperties
}
