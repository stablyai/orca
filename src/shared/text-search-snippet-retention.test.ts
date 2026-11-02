import { describe, expect, it } from 'vitest'
import { createAccumulator, ingestRgJsonLine } from './text-search'

function heapAfterCollection(): number {
  if (!globalThis.gc) {
    throw new Error('This regression requires the test runner to enable --expose-gc')
  }
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

function collectSnippets() {
  const accumulator = createAccumulator()
  for (let index = 0; index < 32; index++) {
    const prefix = String.fromCharCode(65 + index).repeat(1024 * 1024)
    ingestRgJsonLine(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: `${index}.txt` },
          line_number: 1,
          lines: { text: `${prefix}needle` },
          submatches: [{ start: prefix.length, end: prefix.length + 6 }]
        }
      }),
      '/root',
      accumulator,
      2000
    )
  }
  return accumulator
}

describe('retained search snippets', () => {
  it('releases large source lines while keeping their clipped results alive', () => {
    collectSnippets()
    const before = heapAfterCollection()
    const accumulator = collectSnippets()
    const retainedBytes = heapAfterCollection() - before

    expect(accumulator.totalMatches).toBe(32)
    for (const file of accumulator.fileMap.values()) {
      expect(file.matches[0].lineContent).toHaveLength(501)
      expect(file.matches[0].lineContent.endsWith('needle')).toBe(true)
      expect(file.matches[0].column).toBe(1024 * 1024 + 1)
    }
    // Without ownership, 32 tiny snippets retain 32 MiB of source strings.
    expect(retainedBytes).toBeLessThan(4 * 1024 * 1024)
  })
})
