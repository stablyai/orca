import { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../rpc-contract/clipboard/clipboard-params'

const CLIPBOARD_IMAGE_UPLOAD_PARALLEL_CHUNKS = 2
// A second queued chunk delays other calls by about one chunk's transfer, so it only pays off on a link where the first chunk was quick.
const CLIPBOARD_IMAGE_UPLOAD_PARALLEL_MAX_FIRST_CHUNK_MS = 250

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

/**
 * Sends every chunk, two at once when the host holds early arrivals and the first chunk was quick; rethrows the first failure.
 * Fails when no chunk settles for `noProgressTimeoutMs`. `append` gets the per-call timeout to use: a queued chunk waits behind
 * the one ahead of it, so it gets one budget per chunk in flight.
 */
export async function appendClipboardImageUploadChunks(
  slot: ClipboardImageUploadSlot,
  contentBase64: string,
  append: (chunk: ClipboardImageUploadChunk, timeoutMs: number) => Promise<unknown>,
  noProgressTimeoutMs: number
): Promise<void> {
  const canOverlap = slot.acceptsOutOfOrderChunks === true
  let window = 1
  const sent: Promise<void>[] = []
  let failure: { error: unknown } | undefined
  let inFlight = 0
  let finished = false
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let reportStall: (error: Error) => void = () => {}
  const stalled = new Promise<never>((_resolve, reject) => {
    reportStall = reject
  })
  stalled.catch(() => {})
  // Progress is a chunk settling, so a slow link that keeps delivering never trips it.
  const watchProgress = () => {
    clearTimeout(stallTimer)
    if (!finished && inFlight > 0) {
      stallTimer = setTimeout(
        () => reportStall(new Error('Clipboard image upload stopped making progress')),
        noProgressTimeoutMs
      )
    }
  }
  let firstChunkSentAt = 0
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      // Waiting on the chunk a window back caps how many early chunks the host must hold.
      if (sent.length >= window) {
        await Promise.race([sent[sent.length - window], stalled])
      }
      if (failure) {
        break
      }
      if (canOverlap && sent.length === 1) {
        window =
          performance.now() - firstChunkSentAt <= CLIPBOARD_IMAGE_UPLOAD_PARALLEL_MAX_FIRST_CHUNK_MS
            ? CLIPBOARD_IMAGE_UPLOAD_PARALLEL_CHUNKS
            : 1
      }
      firstChunkSentAt ||= performance.now()
      inFlight += 1
      if (inFlight === 1) {
        watchProgress()
      }
      sent.push(
        append(
          {
            uploadId: slot.uploadId,
            offset,
            contentBase64: contentBase64.slice(
              offset,
              offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
            )
          },
          noProgressTimeoutMs * window
        )
          .then(
            () => undefined,
            (error: unknown) => {
              failure ??= { error }
            }
          )
          .finally(() => {
            inFlight -= 1
            watchProgress()
          })
      )
    }
    // Settle every in-flight chunk first so the caller's abort is the last call the host sees.
    await Promise.race([Promise.all(sent), stalled])
  } finally {
    finished = true
    clearTimeout(stallTimer)
  }
  if (failure) {
    throw failure.error
  }
}
