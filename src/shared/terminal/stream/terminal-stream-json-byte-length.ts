/** Budget serialized JSON, not raw terminal text: ESC expands to six bytes, so an ANSI snapshot can fit the desktop budget yet kill its bridge stream.
 * Scan per output chunk to avoid full copies; attach-time snapshot budgeting serializes once for exact frame sizing. */

/** `\b \t \n \f \r` have two-character escapes; every other control character costs `\uXXXX`. */
const SHORT_ESCAPED_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

const TWO_CHARACTER_ESCAPE_BYTES = 2
const UNICODE_ESCAPE_BYTES = 6
const QUOTE_BYTES = 2

const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff
const LOW_SURROGATE_START = 0xdc00
const LOW_SURROGATE_END = 0xdfff

/** Match JSON.stringify UTF-8 size including quotes: short control escapes, six-byte controls/lone surrogates and four-byte surrogate pairs. */
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
