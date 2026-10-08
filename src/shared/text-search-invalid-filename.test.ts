import { expect, it } from 'vitest'
import { createAccumulator, ingestRgJsonLine } from './text-search'

it('reports byte-only filenames as incomplete without inventing a replacement-character path', () => {
  const acc = createAccumulator()
  const line = JSON.stringify({
    type: 'match',
    data: {
      path: { bytes: Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]).toString('base64') },
      lines: { text: 'needle\n' },
      line_number: 1,
      submatches: [{ start: 0, end: 6 }]
    }
  })
  expect(ingestRgJsonLine(line, '/root', acc, 20)).toBe('continue')
  expect(acc.truncated).toBe(true)
  expect(acc.totalMatches).toBe(0)
  expect(acc.fileMap.size).toBe(0)
})
