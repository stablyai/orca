import { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../rpc-contract/clipboard/clipboard-params'

// Each chunk is ~0.7 MB on the wire, so 4 fill a typical remote link's bandwidth-delay product.
const CLIPBOARD_IMAGE_UPLOAD_CHUNKS_IN_FLIGHT = 4

/** The `clipboard.startImageUpload` reply. */
export type ClipboardImageUploadSlot = {
  uploadId: string
  acceptsOutOfOrderChunks?: boolean
}

export type ClipboardImageUploadChunk = {
  uploadId: string
  offset: number
  contentBase64: string
}

/** Sends every chunk, several at once when the host holds early arrivals; rethrows the first failure. */
export async function appendClipboardImageUploadChunks(
  slot: ClipboardImageUploadSlot,
  contentBase64: string,
  append: (chunk: ClipboardImageUploadChunk) => Promise<unknown>
): Promise<void> {
  const inFlight =
    slot.acceptsOutOfOrderChunks === true ? CLIPBOARD_IMAGE_UPLOAD_CHUNKS_IN_FLIGHT : 1
  let nextOffset = 0
  let failure: { error: unknown } | undefined
  const sendChunks = async (): Promise<void> => {
    while (!failure && nextOffset < contentBase64.length) {
      const offset = nextOffset
      nextOffset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
      try {
        await append({
          uploadId: slot.uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        })
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  // Settle every in-flight chunk first so the caller's abort is the last call the host sees.
  await Promise.all(Array.from({ length: inFlight }, sendChunks))
  if (failure) {
    throw failure.error
  }
}
