import { gunzipSync } from 'node:zlib'
import type { CompressedFrameCodec } from '../paired-e2ee-compressed-frame'

const utf8 = new TextDecoder()

export const NODE_COMPRESSED_FRAME_CODEC: CompressedFrameCodec = {
  // Why sync: frames must reach consumers in arrival order, and a level-1 member inflates in microseconds.
  gunzip: (gzipped, outputLimit) => {
    const bytes = gunzipSync(gzipped, { maxOutputLength: outputLimit })
    // Why copy: zlib's pooled or chunk-sized backing store would otherwise travel with posted bytes.
    return bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes)
  },
  decodeUtf8: (bytes) => utf8.decode(bytes)
}
