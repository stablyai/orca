import { describe, expect, it, vi } from 'vitest'
import { isTrackedPathSpec, partitionTrackedPathSpecs } from './git-tracked-pathspecs'

function countNormalizations(run: () => unknown): number {
  const replace = vi.spyOn(String.prototype, 'replace')
  try {
    run()
    return replace.mock.calls.filter(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\\\'
    ).length
  } finally {
    replace.mockRestore()
  }
}

describe('tracked pathspec partition', () => {
  it.each([
    ['docs', ['docs/readme.md'], true],
    ['doc', ['docs/readme.md'], false],
    ['docs/file', ['docs/file-extra'], false],
    ['docs///', ['docs\\readme.md'], true],
    ['src\\file.ts\\', ['src/file.ts///'], true],
    ['DOCS', ['docs/readme.md'], false],
    ['./docs', ['docs/readme.md'], false],
    ['docs//file', ['docs/file'], false],
    ['docs/../file', ['file'], false],
    ['[ab].txt', ['a.txt'], false],
    ['[ab].txt', ['[ab].txt'], true],
    [':(glob)*', ['a.txt'], false],
    ['a b/é', ['a b/é/file\nname'], true],
    ['é', ['e\u0301'], false],
    ['C:\\repo\\docs', ['C:/repo/docs/file'], true],
    ['\\\\host\\share', ['//host/share/file'], true],
    ['', [], false],
    ['', ['relative'], false],
    ['', ['/absolute'], true],
    ['/', [''], true]
  ] as const)('keeps matching semantics for %j against %j', (request, tracked, expected) => {
    expect(isTrackedPathSpec(request, tracked)).toBe(expected)
    expect(partitionTrackedPathSpecs([request], tracked)).toEqual(
      expected
        ? { trackedPaths: [request], untrackedPaths: [] }
        : { trackedPaths: [], untrackedPaths: [request] }
    )
  })

  it('preserves original spelling, duplicates and relative order in both action lists', () => {
    const requests = ['new', 'docs\\', '[ab].txt', 'docs///', 'new', 'src/file', 'docs\\']
    const tracked = ['docs/readme', 'src/file-extra', '[ab].txt', 'docs/readme']
    expect(partitionTrackedPathSpecs(requests, tracked)).toEqual({
      trackedPaths: ['docs\\', '[ab].txt', 'docs///', 'docs\\'],
      untrackedPaths: ['new', 'new', 'src/file']
    })
  })

  it('normalizes each visited tracked entry once and each request once per operation', () => {
    const requests = Array.from({ length: 64 }, (_, index) => `missing/${index}`)
    const tracked = Array.from({ length: 256 }, (_, index) => `docs\\file-${index}///`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(requests, tracked))).toBe(320)
  })

  it('retains early exit for a selected directory with many tracked descendants', () => {
    const tracked = Array.from({ length: 64 }, (_, index) => `docs/file-${index}`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(['docs'], tracked))).toBe(2)
    expect(countNormalizations(() => partitionTrackedPathSpecs([], tracked))).toBe(0)
  })

  it('does not reuse tracked evidence across operations', () => {
    expect(partitionTrackedPathSpecs(['docs'], ['docs/file']).trackedPaths).toEqual(['docs'])
    expect(partitionTrackedPathSpecs(['docs'], []).untrackedPaths).toEqual(['docs'])
  })
})
