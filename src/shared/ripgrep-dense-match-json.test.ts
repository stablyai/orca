import { expect, it } from 'vitest'
import { parseDenseRipgrepMatchJson } from './ripgrep-dense-match-json'

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
    for (const encoded of [record, record.replaceAll('\ufeff', '\\uFEFF')]) {
      expect(parseDenseRipgrepMatchJson(encoded, 1, 16)).toEqual(JSON.parse(record))
    }
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

it('validates submatches after reaching the requested result cap', () => {
  const source = JSON.stringify({
    type: 'match',
    data: {
      submatches: [
        { start: 0, end: 1 },
        { start: null, end: 2 }
      ]
    }
  })
  expect(() => parseDenseRipgrepMatchJson(source, 1, 16)).toThrow('Invalid rg submatch')
})

it('rejects duplicate coordinate fields whose final value is not numeric', () => {
  const source = '{"data":{"submatches":[{"start":0,"start":{},"end":1}]}}'
  expect(() => parseDenseRipgrepMatchJson(source, 1, 16)).toThrow('Invalid rg submatch')
})

it.each([16_378, 16_379])('retains the existing per-element token budget at %i values', (count) => {
  const source = JSON.stringify({
    data: { submatches: [{ start: 0, end: 1, other: Array(count).fill(0) }] }
  })
  const parse = (): unknown => parseDenseRipgrepMatchJson(source, 1, 16)
  if (count === 16_378) {
    expect(parse()).toMatchObject({ data: { submatches: [{ start: 0, end: 1 }] } })
  } else {
    expect(parse).toThrow('rg submatch structure exceeds limit')
  }
})
