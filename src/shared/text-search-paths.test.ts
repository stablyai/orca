import { describe, expect, it } from 'vitest'
import { createAccumulator, ingestRgJsonLine } from './text-search'
import { resolveSearchResultPath } from './text-search-paths'

describe('text search result paths', () => {
  it.each([
    ['/root/repo', './src/a.ts', '/root/repo/src/a.ts'],
    ['/root/repo', '/root/repo/src/a.ts', '/root/repo/src/a.ts'],
    ['C:\\repo', './src/a.ts', 'C:\\repo\\src\\a.ts'],
    ['C:\\repo', 'C:/repo/src/a.ts', 'C:/repo/src/a.ts'],
    ['\\\\wsl.localhost\\Ubuntu\\repo', './src/a.ts', '\\\\wsl.localhost\\Ubuntu\\repo\\src\\a.ts']
  ])('resolves %s and %s on the owning host', (root, reported, expected) => {
    expect(resolveSearchResultPath(root, reported)).toBe(expected)
  })

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
