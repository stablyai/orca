import { expect, it } from 'vitest'
import { generatedNoteImageSize } from './generated-note-image'

// A whole 2x3 RGBA PNG: signature, IHDR, one IDAT and IEND, each with its real CRC.
const PNG_2x3 = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0,
  0, 185, 234, 222, 129, 0, 0, 0, 27, 73, 68, 65, 84, 120, 156, 99, 96, 208, 8, 168, 88, 112, 226,
  131, 4, 3, 132, 114, 200, 96, 128, 80, 19, 118, 0, 0, 146, 219, 11, 161, 109, 59, 12, 242, 0, 0,
  0, 0, 73, 69, 78, 68, 174, 66, 96, 130
]
// A whole 2001x1 RGB PNG: well formed, one pixel wider than the edge limit.
const PNG_2001x1 = Uint8Array.from(
  '89504e470d0a1a0a0000000d49484452000007d1000000010802000000e65dc9140000005749444154789cedc9110283000000c0300cc3300cc3300cc3300cc370380cc3301c0ec3300cc330ec0b3de04e2f08d2aa9fd62b2edaefef08b37a98b73b29bbf17f4679f35976efbdf7de7befbdf7de7befbdf7debffa079b285bdea4d31d330000000049454e44ae426082'
    .match(/../g)!
    .map((pair) => Number.parseInt(pair, 16))
)

it('accepts only a whole, checksummed PNG within the notes-image limits', () => {
  expect(generatedNoteImageSize(Uint8Array.from(PNG_2x3))).toEqual({ width: 2, height: 3 })

  // Cut off: inside the IHDR, before IEND, and inside the last chunk.
  expect(generatedNoteImageSize(Uint8Array.from(PNG_2x3.slice(0, 26)))).toBeNull()
  expect(generatedNoteImageSize(Uint8Array.from(PNG_2x3.slice(0, 72)))).toBeNull()
  expect(generatedNoteImageSize(Uint8Array.from(PNG_2x3.slice(0, -1)))).toBeNull()
  // Anything after IEND.
  expect(generatedNoteImageSize(Uint8Array.from([...PNG_2x3, 0]))).toBeNull()
  // A changed header field or image byte no longer matches its chunk's CRC.
  const header = Uint8Array.from(PNG_2x3)
  header[19] = 9
  expect(generatedNoteImageSize(header)).toBeNull()
  const data = Uint8Array.from(PNG_2x3)
  data[50] ^= 1
  expect(generatedNoteImageSize(data)).toBeNull()
  // Well formed, but wider than agents read images.
  expect(generatedNoteImageSize(PNG_2001x1)).toBeNull()
  expect(generatedNoteImageSize(Uint8Array.from({ length: 64 }, () => 7))).toBeNull()
  expect(generatedNoteImageSize(PNG_2x3)).toBeNull()
})
