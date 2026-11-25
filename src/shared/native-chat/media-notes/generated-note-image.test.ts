import { expect, it } from 'vitest'
import { generatedNoteImageSize } from './generated-note-image'

// Signature, then IHDR for a 2x3 8-bit RGBA image with its real CRC.
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const HEADER_2x3 = SIGNATURE.concat(
  [0, 0, 0, 13, 73, 72, 68, 82],
  [0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0],
  [185, 234, 222, 129]
)
// The same chunk for a 5000-pixel-wide image, CRC included: well formed, but over the edge limit.
const HEADER_5000x3 = SIGNATURE.concat(
  [0, 0, 0, 13, 73, 72, 68, 82],
  [0, 0, 19, 136, 0, 0, 0, 3, 8, 6, 0, 0, 0],
  [127, 217, 229, 131]
)

it('accepts only a complete, checksummed PNG header within the size limit', () => {
  expect(generatedNoteImageSize(Uint8Array.from(HEADER_2x3))).toEqual({ width: 2, height: 3 })

  // Cut off inside the IHDR chunk: the bytes before width and height alone are not enough.
  expect(generatedNoteImageSize(Uint8Array.from(HEADER_2x3.slice(0, 26)))).toBeNull()
  // A changed field no longer matches the chunk's CRC.
  const tampered = Uint8Array.from(HEADER_2x3)
  tampered[19] = 9
  expect(generatedNoteImageSize(tampered)).toBeNull()
  // Well formed, but too large to decode.
  expect(generatedNoteImageSize(Uint8Array.from(HEADER_5000x3))).toBeNull()
  expect(generatedNoteImageSize(Uint8Array.from({ length: 64 }, () => 7))).toBeNull()
  expect(generatedNoteImageSize([...HEADER_2x3])).toBeNull()
})
