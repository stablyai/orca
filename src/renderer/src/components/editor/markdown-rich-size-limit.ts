import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'

// Even overrides build whole documents synchronously; larger previews previously blocked for seconds and retained gigabytes.
export const MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES = 1024 * 1024

const markdownSizeEncoder = new TextEncoder()
// Reuse the buffer to avoid allocating large byte arrays on render-time content checks.
const markdownSizeBuffer = new Uint8Array(
  Math.max(RICH_MARKDOWN_MAX_SIZE_BYTES, MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES) + 1
)

function exceedsUtf8ByteLimit(content: string, limit: number): boolean {
  // Why: each UTF-16 unit encodes to 1-3 bytes, so most sizes resolve without encoding.
  if (content.length > limit) {
    return true
  }
  if (content.length * 3 <= limit) {
    return false
  }
  const probe = markdownSizeEncoder.encodeInto(content, markdownSizeBuffer.subarray(0, limit + 1))
  // encodeInto never writes partial code points; unread multibyte text can remain even when written equals the limit.
  return probe.written > limit || probe.read < content.length
}

export function exceedsMarkdownRichModeSizeLimit(markdownContent: string): boolean {
  return exceedsUtf8ByteLimit(markdownContent, RICH_MARKDOWN_MAX_SIZE_BYTES)
}

export function exceedsMarkdownRenderOverrideSizeLimit(markdownContent: string): boolean {
  return exceedsUtf8ByteLimit(markdownContent, MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES)
}

export function canRenderMarkdownAtSize(markdownContent: string, sizeOverridden: boolean): boolean {
  return sizeOverridden
    ? !exceedsMarkdownRenderOverrideSizeLimit(markdownContent)
    : !exceedsMarkdownRichModeSizeLimit(markdownContent)
}
