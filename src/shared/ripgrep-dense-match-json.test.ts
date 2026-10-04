import { expect, it } from 'vitest'
import { JSONParser } from '@streamparser/json'
import { parseDenseRipgrepMatchJson } from './ripgrep-dense-match-json'

it.each([0, 64 * 1024])('preserves literal and escaped BOMs with buffer size %i', (size) => {
  const source = { '\ufeffkey': `\ufeffstart${'\n'.repeat(64 * 1024)}\ufeffend` }
  const literal = JSON.stringify(source)
  for (const record of [literal, literal.replaceAll('\ufeff', '\\uFEFF')]) {
    const parser = new JSONParser({ stringBufferSize: size })
    let parsed: unknown
    parser.onValue = ({ value, stack }) => {
      if (stack.length === 0) {
        parsed = value
      }
    }
    parser.write(record)
    expect(parsed).toEqual(JSON.parse(record))
  }
})

it.each(['', '\\', '\n', '\n'.repeat(64 * 1024), `${'x'.repeat(64 * 1024)}\n`])(
  'preserves U+FEFF in text and filenames across string-buffer boundaries (%#)',
  (prefix) => {
    const text = `${prefix}\ufeff😀x`
    const source = {
      type: 'match',
      data: {
        path: { text },
        lines: { text },
        line_number: 1,
        submatches: [{ start: 0, end: 1 }]
      }
    }
    const record = JSON.stringify(source)
    expect(parseDenseRipgrepMatchJson(record, 1, 16)).toEqual(JSON.parse(record))
  }
)

it('retains only exact match fields and the remaining range budget', () => {
  const ranges = [
    { start: 0, end: 1 },
    { start: 2, end: 3 }
  ]
  const source = {
    type: 'match',
    submatches: [{ start: 99, end: 100 }],
    data: {
      nested: { submatches: [{ start: 88, end: 89 }] },
      lines: { text: 'a "submatches" b', bytes: 'YQ==' },
      path: { text: '/root/a.ts' },
      line_number: 12,
      submatches: ranges
    }
  }
  expect(parseDenseRipgrepMatchJson(JSON.stringify(source), 1, 16)).toEqual({
    type: 'match',
    data: {
      lines: source.data.lines,
      path: source.data.path,
      line_number: 12,
      submatches: ranges.slice(0, 1)
    }
  })
})

it('rejects depth overflow and invalid submatch shapes', () => {
  expect(() => parseDenseRipgrepMatchJson('['.repeat(17), 2, 16)).toThrow()
  expect(() => parseDenseRipgrepMatchJson('{"data":{"submatches":[null]}}', 2, 16)).toThrow()
})

it.each(['{}', '{"type":"begin","data":{}}', '{"data":null}', '{"data":[]}'])(
  'does not fabricate a match from %s',
  (source) => {
    const projected = parseDenseRipgrepMatchJson(source, 2, 16)
    expect(projected.data?.path).toBeUndefined()
    expect(projected.data?.submatches).toEqual([])
  }
)
