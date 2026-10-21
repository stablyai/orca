import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'

// Why: "Open anyway"/"Render anyway" still build the whole document in one task;
// in Electron 43 on M-series a ~1 MB preview blocks 3.8 s at 1.3 GB and 2 MB
// blocks 7.8 s at 2.3 GB, so no override renders past this.
export const MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES = 1024 * 1024

const markdownSizeEncoder = new TextEncoder()
// Why: size checks run during render-model work, so this avoids allocating a
// large Uint8Array every time markdown content changes.
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
  // Why: encodeInto() never writes partial UTF-8 sequences. A multibyte
  // character can leave written at the exact limit while unread content remains.
  return probe.written > limit || probe.read < content.length
}

export function exceedsMarkdownRichModeSizeLimit(markdownContent: string): boolean {
  return exceedsUtf8ByteLimit(markdownContent, RICH_MARKDOWN_MAX_SIZE_BYTES)
}

export function exceedsMarkdownRenderOverrideSizeLimit(markdownContent: string): boolean {
  return exceedsUtf8ByteLimit(markdownContent, MARKDOWN_RENDER_OVERRIDE_MAX_SIZE_BYTES)
}

/** Whether a rendered (rich or preview) markdown surface may build this document. */
export function canRenderMarkdownAtSize(markdownContent: string, sizeOverridden: boolean): boolean {
  return sizeOverridden
    ? !exceedsMarkdownRenderOverrideSizeLimit(markdownContent)
    : !exceedsMarkdownRichModeSizeLimit(markdownContent)
}
