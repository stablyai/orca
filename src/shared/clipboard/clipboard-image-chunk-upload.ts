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
  const window = slot.acceptsOutOfOrderChunks === true ? CLIPBOARD_IMAGE_UPLOAD_CHUNKS_IN_FLIGHT : 1
  const sent: Promise<void>[] = []
  let failure: { error: unknown } | undefined
  for (
    let offset = 0;
    offset < contentBase64.length;
    offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
  ) {
    // Waiting on the chunk a window back caps how many early chunks the host must hold.
    if (sent.length >= window) {
      await sent[sent.length - window]
    }
    if (failure) {
      break
    }
    sent.push(
      append({
        uploadId: slot.uploadId,
        offset,
        contentBase64: contentBase64.slice(
          offset,
          offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
        )
      }).then(
        () => undefined,
        (error: unknown) => {
          failure ??= { error }
        }
      )
    )
  }
  // Settle every in-flight chunk first so the caller's abort is the last call the host sees.
  await Promise.all(sent)
  if (failure) {
    throw failure.error
  }
}
