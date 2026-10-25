import { describe, expect, it } from 'vitest'
import { terminalStreamJsonByteLength } from './terminal-stream-json-byte-length'

/** Use JSON.stringify as the oracle: a size scan can avoid snapshot copies only if it matches every serializer input class. */

const CASES: [string, string][] = [
  ['empty', ''],
  ['plain ascii', 'hello world'],
  ['a quote and a backslash', 'a "quoted" c:\\path\\to'],
  ['the five short escapes', '\b\t\n\f\r'],
  [
    'every other control character',
    String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i))
  ],
  ['delete and high ascii', '\u007f\u0080\u07ff'],
  ['two-byte and three-byte scalars', 'é ü ± 日本語 …'],
  ['a surrogate pair', '🙂 emoji 👍🏽'],
  ['a lone high surrogate', 'a\ud800b'],
  ['a lone low surrogate', 'a\udc00b'],
  ['a high surrogate at the end', 'trailing\ud83d'],
  ['an ANSI colour run', '\u001b[38;5;196mred\u001b[0m\r\n'],
  ['a full SGR screen line', '\u001b[01;31m\u001b[Kmatch\u001b[m\u001b[K'.repeat(40)]
]

describe('the JSON size of a terminal payload', () => {
  it.each(CASES)('agrees with JSON.stringify: %s', (_label, value) => {
    expect(terminalStreamJsonByteLength(value)).toBe(
      Buffer.byteLength(JSON.stringify(value), 'utf8')
    )
  })

  it('agrees on a screen built from every class at once', () => {
    const mixed = CASES.map(([, value]) => value).join('\u001b[0m')
    expect(terminalStreamJsonByteLength(mixed)).toBe(
      Buffer.byteLength(JSON.stringify(mixed), 'utf8')
    )
  })

  it('costs an ANSI snapshot far more than its text, which is the whole reason it exists', () => {
    // Raw text fits the desktop budget while its escaped JSON can exceed the bridge frame cap.
    const screen = '\u001b[38;5;196m#'.repeat(20_000)
    expect(terminalStreamJsonByteLength(screen)).toBeGreaterThan(
      Buffer.byteLength(screen, 'utf8') * 1.4
    )
  })
})
