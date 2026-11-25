/** The view a newly opened Markdown file starts in; per-tab toggles still override it. */
export type MarkdownDefaultViewMode = 'source' | 'rich'

export const DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE: MarkdownDefaultViewMode = 'rich'

/** Profiles saved before the setting existed (or with a malformed value) keep opening in Rich. */
export function normalizeMarkdownDefaultViewMode(value: unknown): MarkdownDefaultViewMode {
  return value === 'source' ? 'source' : DEFAULT_MARKDOWN_DEFAULT_VIEW_MODE
}
