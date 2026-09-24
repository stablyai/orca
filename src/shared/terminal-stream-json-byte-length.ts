/**
 * What a terminal snapshot costs once it is a JSON string, which is the only size that matters to
 * a client reading it through the page bridge.
 *
 * The raw budget the desktop has always applied measures the text. The bridge measures the frame,
 * and the two are not close: every ESC byte in an ANSI snapshot is a control character, so
 * `JSON.stringify` spends six bytes on the one byte the text spent, and a colour-dense screen
 * crosses 1.4x. A 512 KiB budgeted snapshot serializes past 640 KiB and the stream that carries it
 * ends before its first live byte.
 *
 * Scanned rather than serialized, because its caller asks per output chunk on a hot stream and a
 * `JSON.stringify` per chunk would copy every byte the terminal prints. The desktop's snapshot
 * budget does serialize, on purpose: it runs once per attach and must not be wrong by a field.
 */

/** `\b \t \n \f \r` have two-character escapes; every other control character costs `\uXXXX`. */
const SHORT_ESCAPED_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

const TWO_CHARACTER_ESCAPE_BYTES = 2
const UNICODE_ESCAPE_BYTES = 6
const QUOTE_BYTES = 2

const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff
const LOW_SURROGATE_START = 0xdc00
const LOW_SURROGATE_END = 0xdfff

/**
 * The UTF-8 bytes `JSON.stringify(data)` produces, quotes included.
 *
 * Matches the serializer's own rules rather than approximating them: the two-character escapes,
 * `\uXXXX` for every other control, and — since ES2019's well-formed JSON.stringify — `\uXXXX` for
 * a lone surrogate, which a snapshot cut mid-character can carry. A surrogate pair is one scalar
 * and four UTF-8 bytes across its two code units.
 */
export function terminalStreamJsonByteLength(data: string): number {
  let bytes = QUOTE_BYTES
  for (let index = 0; index < data.length; index += 1) {
    const unit = data.charCodeAt(index)
    if (unit === 0x22 || unit === 0x5c) {
      bytes += TWO_CHARACTER_ESCAPE_BYTES
    } else if (unit < 0x20) {
      bytes += SHORT_ESCAPED_CONTROLS.has(unit) ? TWO_CHARACTER_ESCAPE_BYTES : UNICODE_ESCAPE_BYTES
    } else if (unit < 0x80) {
      bytes += 1
    } else if (unit < 0x800) {
      bytes += 2
    } else if (unit >= HIGH_SURROGATE_START && unit <= HIGH_SURROGATE_END) {
      const next = index + 1 < data.length ? data.charCodeAt(index + 1) : 0
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) {
        // One scalar over two units: four UTF-8 bytes, and the low half is not read again.
        bytes += 4
        index += 1
      } else {
        bytes += UNICODE_ESCAPE_BYTES
      }
    } else if (unit >= LOW_SURROGATE_START && unit <= LOW_SURROGATE_END) {
      bytes += UNICODE_ESCAPE_BYTES
    } else {
      bytes += 3
    }
  }
  return bytes
}
