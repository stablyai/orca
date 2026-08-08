import { describe, expect, it } from 'vitest'
import { normalizeSgrDensity } from './terminal-sgr-normalizer'

describe('normalizeSgrDensity', () => {
  it('leaves plain text untouched', () => {
    expect(normalizeSgrDensity('hello world\r\n')).toBe('hello world\r\n')
  })

  it('keeps a reset that is followed by text', () => {
    const input = '\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m\n'
    expect(normalizeSgrDensity(input)).toBe(input)
  })

  it('collapses identical adjacent SGR sequences (rule 1)', () => {
    expect(normalizeSgrDensity('\x1b[31m\x1b[31ma\x1b[31mb')).toBe('\x1b[31mab')
  })

  it('drops a reset immediately followed by a covering SGR (rule 2)', () => {
    // Character-level highlight: red x, then green y — the 0m between them is
    // redundant because 32m re-specifies the only attribute (fg).
    expect(normalizeSgrDensity('\x1b[31mx\x1b[0m\x1b[32my\x1b[0m')).toBe(
      '\x1b[31mx\x1b[32my\x1b[0m'
    )
  })

  it('keeps the reset when the following SGR does not cover attributes', () => {
    // Bold is active before the reset; 32m does not clear it, so 0m must stay.
    expect(normalizeSgrDensity('\x1b[1m\x1b[31mx\x1b[0m\x1b[32my\x1b[0m')).toBe(
      '\x1b[1m\x1b[31mx\x1b[0m\x1b[32my\x1b[0m'
    )
  })

  it('collapses consecutive bare resets to one (semantics-preserving)', () => {
    expect(normalizeSgrDensity('\x1b[31ma\x1b[0m\x1b[0mb')).toBe('\x1b[31ma\x1b[0mb')
  })

  it('passes OSC strings through byte-identical', () => {
    const input = '\x1b]0;my title\x1b\\\x1b[31ma\x1b[0m'
    expect(normalizeSgrDensity(input)).toBe(input)
  })

  it('passes non-SGR CSI sequences through', () => {
    const input = '\x1b[2J\x1b[31ma\x1b[0m\x1b[1;1H'
    expect(normalizeSgrDensity(input)).toBe(input)
  })

  it('handles 256-color and truecolor SGR parameters', () => {
    expect(normalizeSgrDensity('\x1b[38;5;196mX\x1b[0m\x1b[38;5;197mY\x1b[0m')).toBe(
      '\x1b[38;5;196mX\x1b[38;5;197mY\x1b[0m'
    )
    expect(normalizeSgrDensity('\x1b[38;2;10;20;30mA\x1b[0m\x1b[38;2;40;50;60mB\x1b[0m')).toBe(
      '\x1b[38;2;10;20;30mA\x1b[38;2;40;50;60mB\x1b[0m'
    )
  })

  it('collapses the same 256-color across many characters', () => {
    const input = '\x1b[38;5;34ma\x1b[38;5;34mb\x1b[38;5;34mc\x1b[0m'
    expect(normalizeSgrDensity(input)).toBe('\x1b[38;5;34mabc\x1b[0m')
  })

  it('keeps runs of different colors (cannot compress, must not break)', () => {
    const input = '\x1b[31ma\x1b[32mb\x1b[33mc\x1b[0m'
    expect(normalizeSgrDensity(input)).toBe('\x1b[31ma\x1b[32mb\x1b[33mc\x1b[0m')
  })

  it('is idempotent', () => {
    const input = '\x1b[31ma\x1b[0m\x1b[32mb\x1b[0m\x1b[38;5;196mc\x1b[0m'
    const once = normalizeSgrDensity(input)
    expect(normalizeSgrDensity(once)).toBe(once)
  })

  it('handles unterminated CSI at end of input', () => {
    const input = '\x1b[31ma\x1b[0m\x1b[3'
    expect(normalizeSgrDensity(input)).toBe('\x1b[31ma\x1b[0m\x1b[3')
  })

  it('preserves newlines and CRLF exactly (resets before newlines stay)', () => {
    const input = '\x1b[32mline1\x1b[0m\r\n\x1b[32mline2\x1b[0m\r\n'
    expect(normalizeSgrDensity(input)).toBe(input)
  })

  it('keeps the reset when a combined reset set attributes', () => {
    expect(normalizeSgrDensity('\x1b[0;1mX\x1b[0m\x1b[32mY')).toBe(
      '\x1b[0;1mX\x1b[0m\x1b[32mY'
    )
  })

  it('keeps SGR state across an OSC string', () => {
    expect(normalizeSgrDensity('\x1b[31mX\x1b]0;title\x07\x1b[0m\x1b[1mY')).toBe(
      '\x1b[31mX\x1b]0;title\x07\x1b[0m\x1b[1mY'
    )
  })

  it('compresses character-level 256-color highlight pattern (realistic)', () => {
    const input =
      '\x1b[38;5;120ma\x1b[0m\x1b[38;5;121mb\x1b[0m\x1b[38;5;122mc\x1b[0m'
    const out = normalizeSgrDensity(input)
    expect(out).toBe('\x1b[38;5;120ma\x1b[38;5;121mb\x1b[38;5;122mc\x1b[0m')
    expect(out.length).toBeLessThan(input.length)
  })

  it('compresses realistic 4KB-sliced stream (density 1, 256-color pattern)', () => {
    const colors = [31, 32, 33, 34, 35, 36, 90, 91, 92, 93, 94, 95, 96, 38, 39, 49]
    let stream = ''
    for (let n = 0; n < 60; n++) {
      for (let c = 0; c < 120; c++) {
        const code = colors[(n + c) % colors.length]
        stream += `\x1b[${code}m${String.fromCharCode(97 + ((n + c) % 26))}\x1b[0m`
      }
      stream += `\x1b[1m ${n}\x1b[0m\r\n`
    }
    const total = stream.length
    const chunks: string[] = []
    for (let offset = 0; offset < stream.length; offset += 4096) {
      chunks.push(stream.slice(offset, offset + 4096))
    }
    const compressed = chunks.map((chunk) => normalizeSgrDensity(chunk)).join('')
    expect(compressed.length).toBeLessThan(total * 0.8)
    // Byte order preserved: strip all ESC sequences and compare payload text.
    // eslint-disable-next-line no-control-regex
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
    expect(strip(compressed)).toBe(strip(stream))
  })

  it('debug covers decisions on a single highlight line', () => {
    const colors = [31, 32, 33, 34, 35, 36, 90, 91, 92, 93, 94, 95, 96, 38, 39, 49]
    let line = ''
    for (let c = 0; c < 8; c++) {
      const code = colors[c % colors.length]
      line += `\x1b[${code}m${String.fromCharCode(97 + (c % 26))}\x1b[0m`
    }
    const out = normalizeSgrDensity(line)
    expect(out.length).toBeLessThan(line.length)
  })
})
