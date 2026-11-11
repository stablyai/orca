import { expect, it } from 'vitest'

import { createAccumulator, ingestRgJsonLine } from './text-search'

function denseRecord(count: number): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: '/root/dense.txt' },
      lines: { text: 'x '.repeat(count) },
      line_number: 1,
      submatches: Array.from({ length: count }, (_, index) => ({
        match: { text: 'x' },
        start: index * 2,
        end: index * 2 + 1
      }))
    }
  })
}

it.each([
  (record: string) => record.slice(0, -1),
  (record: string) => `${record.slice(0, -2)},invalid}`,
  (record: string) => `${record.slice(0, -1)},"data":{}}`,
  (record: string) => `${record.slice(0, -2)},"submatches":[]}}`
])(
  'rejects invalid tails or duplicate envelope keys without retaining early matches',
  (corrupt) => {
    const accumulator = createAccumulator()
    ingestRgJsonLine(corrupt(denseRecord(10_000)), '/root', accumulator, 2000)
    expect(accumulator.totalMatches).toBe(0)
    expect(accumulator.truncated).toBe(true)
  }
)
