/** Markdown view a `.md` edit tab opens in before the user toggles it for that tab. */
export type MarkdownDefaultViewMode = 'source' | 'rich' | 'preview'

export const MARKDOWN_DEFAULT_VIEW_MODES = [
  'source',
  'rich',
  'preview'
] as const satisfies readonly MarkdownDefaultViewMode[]

export const DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE: MarkdownDefaultViewMode = 'rich'

export function isMarkdownDefaultViewMode(value: unknown): value is MarkdownDefaultViewMode {
  return MARKDOWN_DEFAULT_VIEW_MODES.some((mode) => mode === value)
}

export function normalizeMarkdownDefaultViewMode(value: unknown): MarkdownDefaultViewMode {
  return isMarkdownDefaultViewMode(value) ? value : DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE
}
