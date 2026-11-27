// How much one tool answer may hand an agent: lists are pages, long text is paged by offset, and
// content still too long is cut with a marker that says so, never silently. Orca's own paging lines
// go after the capped content, so they always survive.

import { sliceAtCodeUnitLimit } from './text/surrogate-safe-text-slice'

export const TOOL_LIST_PAGE_SIZE = 20
export const TOOL_OUTPUT_MAX_CHARS = 20_000
/** A text page leaves room under the cap for Orca's lines and fences around it. */
export const TOOL_TEXT_PAGE_CHARS = 16_000
/** The most bytes one answer carries (a download, an attachment): base64 of this fits a paired
 *  server's 4 MiB reply with room to spare. */
export const TOOL_DOWNLOAD_MAX_BYTES = 2_900_000

/** One page of a long text, and where the next one starts when there is more. */
export function pageOfText(
  text: string,
  offset = 0,
  size = TOOL_TEXT_PAGE_CHARS
): { text: string; total: number; nextOffset?: number } {
  const start = Math.min(Math.max(0, offset), text.length)
  const page = sliceAtCodeUnitLimit(text.slice(start), size)
  const end = start + page.length
  return {
    text: page,
    total: text.length,
    ...(end < text.length ? { nextOffset: end } : {})
  }
}

/** Orca's line saying content was cut, and how to see less at once. */
export function truncationNote(length: number, hint: string, kept: number): string {
  return `[Orca: truncated at ${kept} of ${length} characters. ${hint}]`
}

/** Content cut at the limit with a marker naming how to see less at once; add paging lines after. */
export function capToolOutput(text: string, hint: string, max = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) {
    return text
  }
  const clipped = sliceAtCodeUnitLimit(text, max)
  return `${clipped}\n${truncationNote(text.length, hint, clipped.length)}`
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}
