import { describe, expect, it } from 'vitest'
import { createAccumulator, ingestRgJsonLine } from './text-search'

describe('text search result paths', () => {
  it('translates an absolute WSL path before resolving its host path', () => {
    const acc = createAccumulator()
    ingestRgJsonLine(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: '/repo/src/a.ts' },
          lines: { text: 'match\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }]
        }
      }),
      '\\\\wsl.localhost\\Ubuntu\\repo',
      acc,
      20,
      (path) => `\\\\wsl.localhost\\Ubuntu${path.replaceAll('/', '\\')}`
    )
    expect([...acc.fileMap.values()][0]?.relativePath).toBe('src/a.ts')
    expect([...acc.fileMap.keys()]).toEqual(['\\\\wsl.localhost\\Ubuntu\\repo\\src\\a.ts'])
  })
})
