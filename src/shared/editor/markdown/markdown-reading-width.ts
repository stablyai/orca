/** Reading column width for Markdown surfaces; full width lifts the 60em cap. */
export type MarkdownReadingWidth = 'centered' | 'full'

export const DEFAULT_MARKDOWN_READING_WIDTH: MarkdownReadingWidth = 'centered'

/** Profiles saved before the setting existed (or with a malformed value) stay centered. */
export function normalizeMarkdownReadingWidth(value: unknown): MarkdownReadingWidth {
  return value === 'full' ? 'full' : DEFAULT_MARKDOWN_READING_WIDTH
}

export type MarkdownReadingWidthSettings = {
  /** Reading column width for the Markdown editor and preview; absent = Centered. */
  markdownReadingWidth?: MarkdownReadingWidth
}
