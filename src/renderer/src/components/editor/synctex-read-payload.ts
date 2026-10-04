import { SYNCTEX_GZIP_MIME_TYPE } from '../../../../shared/synctex-file-path'

type FileReadPayload = { content: string; isBinary: boolean; mimeType?: string }

/**
 * SyncTeX text from a host file read, or null when there is none to use. `.synctex.gz`
 * arrives base64 and is inflated here; an uncompressed `.synctex` arrives as text. A
 * host that predates the gzip allowance replies with empty binary content, which reads
 * as "no SyncTeX" so the PDF falls back to page positions.
 */
export async function synctexTextFromRead(payload: FileReadPayload): Promise<string | null> {
  if (!payload.content) {
    return null
  }
  if (!payload.isBinary) {
    return payload.content
  }
  if (payload.mimeType !== SYNCTEX_GZIP_MIME_TYPE) {
    return null
  }
  const binary = atob(payload.content)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(inflated).text()
}
