import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'

const richMarkdownSizeEncoder = new TextEncoder()
// Why: rich-mode eligibility is checked during render-model work, so this
// avoids allocating a large Uint8Array every time markdown content changes.
const richMarkdownSizeBuffer = new Uint8Array(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)

export function exceedsMarkdownRichModeSizeLimit(markdownContent: string): boolean {
  const probe = richMarkdownSizeEncoder.encodeInto(markdownContent, richMarkdownSizeBuffer)

  // Why: encodeInto() never writes partial UTF-8 sequences. A multibyte
  // character can leave written at the exact limit while unread content remains.
  return probe.written > RICH_MARKDOWN_MAX_SIZE_BYTES || probe.read < markdownContent.length
}
