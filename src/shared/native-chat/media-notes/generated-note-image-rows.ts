import { generatedNoteImageLayout } from './generated-note-image'

/** Whether `bytes` is a whole notes PNG whose image data inflates to exactly its rows, each with a
 *  valid filter byte: the same check main makes on desktop, for clients that decode in the browser.
 *  Reading stops as soon as the data runs past the image's own size. */
export async function generatedNoteImageRowsDecode(bytes: unknown): Promise<boolean> {
  const layout = generatedNoteImageLayout(bytes)
  if (!layout || typeof DecompressionStream === 'undefined') {
    return false
  }
  const rowLength = layout.rawByteLength / layout.height
  const reader = new Blob(layout.data.map((chunk) => new Uint8Array(chunk)))
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      for (let index = 0; index < value.length; index += 1) {
        if ((total + index) % rowLength === 0 && value[index] > 4) {
          void reader.cancel()
          return false
        }
      }
      total += value.length
      if (total > layout.rawByteLength) {
        void reader.cancel()
        return false
      }
    }
  } catch {
    return false
  }
  return total === layout.rawByteLength
}
