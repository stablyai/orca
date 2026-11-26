/** How wide the Markdown reading column grows in a wide editor pane. */
export type MarkdownReadingWidth = 'narrow' | 'wide' | 'full'

export const DEFAULT_MARKDOWN_READING_WIDTH: MarkdownReadingWidth = 'narrow'

/** Profiles saved before the setting existed (or with a malformed value) keep the current measure. */
export function normalizeMarkdownReadingWidth(value: unknown): MarkdownReadingWidth {
  return value === 'wide' || value === 'full' ? value : DEFAULT_MARKDOWN_READING_WIDTH
}
