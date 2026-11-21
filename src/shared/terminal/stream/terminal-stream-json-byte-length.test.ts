import { expect, it } from 'vitest'
import { terminalStreamJsonByteLength } from './terminal-stream-json-byte-length'

const cases = [
  ['empty', '', 2],
  ['plain text with quotes and backslashes', 'a "quoted" c:\\path\\to', 27],
  ['ASCII controls', String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)), 174],
  ['delete and two-byte UTF-8 boundaries', '\u007f\u0080\u07ff', 7],
  ['two-byte and three-byte scalars', 'é ü ± 日本語 …', 24],
  ['surrogate pairs', '🙂 emoji 👍🏽', 21],
  ['a lone high surrogate', 'a\ud800b', 10],
  ['a lone low surrogate', 'a\udc00b', 10],
  ['a high surrogate at the end', 'trailing\ud83d', 16]
] as const

it.each(cases)('measures the JSON UTF-8 size for %s', (_label, value, bytes) => {
  expect(terminalStreamJsonByteLength(value)).toBe(bytes)
})
