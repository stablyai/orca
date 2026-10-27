import { createRipgrepOffsetReader } from './ripgrep-match-offsets'

function utf8SequenceWidth(bytes: Buffer, start: number): number {
  const lead = bytes[start]!
  const expected =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1
  for (let offset = 1; offset < expected; offset++) {
    const next = bytes[start + offset]
    if (
      next === undefined ||
      next < 0x80 ||
      next > 0xbf ||
      (offset === 1 &&
        ((lead === 0xe0 && next < 0xa0) ||
          (lead === 0xed && next >= 0xa0) ||
          (lead === 0xf0 && next < 0x90) ||
          (lead === 0xf4 && next >= 0x90)))
    ) {
      return offset
    }
  }
  return expected
}

function createDecodedByteOffsetReader(bytes: Buffer): (offset: number) => number | null {
  let position = 0
  let column = 0
  return (offset) => {
    if (!Number.isSafeInteger(offset) || offset < position) {
      return null
    }
    while (position < offset && position < bytes.length) {
      const width = utf8SequenceWidth(bytes, position)
      position += width
      column += width === 4 ? 2 : 1
    }
    return offset === position ? column : null
  }
}

/** Decode once; malformed sequences retain their original byte widths for match coordinates. */
export function decodeRipgrepLine(data: { text?: string; bytes?: string } | undefined): {
  text: string
  readOffset: (offset: number) => number | null
} {
  if (typeof data?.text === 'string') {
    return { text: data.text.replace(/\n$/, ''), readOffset: createRipgrepOffsetReader(data.text) }
  }
  const bytes = Buffer.from(data?.bytes ?? '', 'base64')
  return {
    text: bytes.toString('utf8').replace(/\n$/, ''),
    readOffset: createDecodedByteOffsetReader(bytes)
  }
}
