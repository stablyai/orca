export const POSIX_PRINTF_RECORD_MAX_BYTES = 1_024
const PRINTF_ESCAPED_BYTES = new Set([0x21, 0x27, 0x5c])

export function* encodePosixPrintfRecords(command: string): Generator<string> {
  let chunk = ''
  let chunkBytes = 0
  for (const character of command) {
    const codePoint = character.codePointAt(0)!
    const isSafePrintableAscii =
      codePoint >= 0x20 && codePoint <= 0x7e && !PRINTF_ESCAPED_BYTES.has(codePoint)
    const encodedCharacter =
      codePoint > 0x7f || isSafePrintableAscii
        ? character
        : `\\0${codePoint.toString(8).padStart(3, '0')}`
    const encodedBytes = codePoint > 0x7f ? Buffer.byteLength(character) : encodedCharacter.length
    if (chunkBytes + encodedBytes > POSIX_PRINTF_RECORD_MAX_BYTES) {
      yield chunk
      chunk = ''
      chunkBytes = 0
    }
    chunk += encodedCharacter
    chunkBytes += encodedBytes
  }
  yield chunk
}
