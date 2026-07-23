import { measureUtf8ByteLength } from './utf8-byte-limits'

export const HTML_TO_PDF_MAX_INPUT_BYTES = 32 * 1024 * 1024
export const HTML_TO_PDF_MEMORY_LIMIT_ERROR = 'HTML export exceeds the PDF memory limit'

export function assertHtmlToPdfInputWithinMemoryLimit(
  html: string,
  maxBytes = HTML_TO_PDF_MAX_INPUT_BYTES
): void {
  if (measureUtf8ByteLength(html, { stopAfterBytes: maxBytes }).exceededLimit) {
    throw new Error(HTML_TO_PDF_MEMORY_LIMIT_ERROR)
  }
}
