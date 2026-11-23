// Stored attachments larger than one agentSessionAttachment.read reply, read in ranges through the
// host's agentSessionAttachment.readTextChunk (any committed store file, despite the name). Hosts
// that answer it advertise AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY.

import {
  attachmentTextChunkSchema,
  type AttachmentTextRequest
} from '../attachment-text/attachment-text-source'
import { MAX_FILE_RANGE_READ_BYTES } from '../file-content/file-range-read'

// A multiple of 3, so every full chunk's base64 joins the next one without padding.
const CHUNK_BYTES = Math.floor(MAX_FILE_RANGE_READ_BYTES / 3) * 3

/** The whole file as base64, every range pinned to the first one's snapshot; null when over `maxBytes`. */
export async function readAttachmentBase64InRanges(
  read: (request: AttachmentTextRequest) => Promise<unknown>,
  path: string,
  maxBytes: number
): Promise<string | null> {
  // A one-byte probe learns the size, so a file over the cap costs no real range.
  const { size, snapshot } = attachmentTextChunkSchema.parse(
    await read({ path, offset: 0, length: 1 })
  )
  if (size > maxBytes) {
    return null
  }
  const parts: string[] = []
  let offset = 0
  while (offset < size) {
    const chunk = attachmentTextChunkSchema.parse(
      await read({ path, offset, length: CHUNK_BYTES, expectedSnapshot: snapshot })
    )
    // The host refuses a changed file per range; these guard a host that never reaches the end.
    if (
      chunk.snapshot !== snapshot ||
      chunk.contentBase64.length !== Math.ceil(chunk.bytesRead / 3) * 4 ||
      offset + chunk.bytesRead > size ||
      chunk.eof !== (offset + chunk.bytesRead === size) ||
      (!chunk.eof && chunk.bytesRead !== CHUNK_BYTES)
    ) {
      throw new Error('Attachment changed while it was loading.')
    }
    parts.push(chunk.contentBase64)
    offset += chunk.bytesRead
  }
  return parts.join('')
}
