import { describe, expect, it, vi } from 'vitest'
import { partitionTrackedPathSpecs } from './git-tracked-pathspecs'

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
    ['docs///', ['docs/readme.md'], true],
    ['DOCS', ['docs/readme.md'], false],
    ['./docs', ['docs/readme.md'], false],
    ['docs//file', ['docs/file'], false],
    ['docs/../file', ['file'], false],
    ['[ab].txt', ['a.txt'], false],
    ['[ab].txt', ['[ab].txt'], true],
    [':(glob)*', ['a.txt'], false],
    ['a b/é', ['a b/é/file\nname'], true],
    ['é', ['e\u0301'], false],
    ['', [], false],
    ['', ['relative'], false],
    ['', ['/absolute'], true],
    ['/', [''], true]
  ] as const)(
    'matches only literal files or descendants for %j against %j',
    (request, tracked, expected) => {
      for (const windowsPaths of [false, true]) {
        expect(partitionTrackedPathSpecs([request], tracked, windowsPaths)).toEqual({
          trackedPaths: expected ? [request] : [],
          untrackedPaths: expected ? [] : [request]
        })
      }
    }
  )

  it.each([
    ['docs\\file', ['docs/file'], false],
    ['docs/file', ['docs\\file'], false],
    ['docs', ['docs\\file'], false],
    ['docs\\', ['docs/file'], false],
    ['docs\\file', ['docs\\file'], true],
    ['docs\\folder', ['docs\\folder/file'], true],
    ['docs///', ['docs/file'], true]
  ] as const)(
    'preserves POSIX filename identity for %j against %j',
    (request, tracked, expected) => {
      expect(partitionTrackedPathSpecs([request], tracked, false)).toEqual({
        trackedPaths: expected ? [request] : [],
        untrackedPaths: expected ? [] : [request]
      })
    }
  )

  it.each([
    ['docs\\', ['docs/readme.md']],
    ['src\\file.ts\\', ['src/file.ts///']],
    ['C:\\repo\\docs', ['C:/repo/docs/file']],
    ['\\\\host\\share', ['//host/share/file']]
  ] as const)('accepts Windows separators for %j against %j', (request, tracked) => {
    expect(partitionTrackedPathSpecs([request], tracked, true)).toEqual({
      trackedPaths: [request],
      untrackedPaths: []
    })
  })

  it.each([false, true])(
    'preserves selection spelling and order with windowsPaths=%j',
    (windowsPaths) => {
      const requests = ['new', 'docs\\', '[ab].txt', 'docs///', 'src/file']
      const tracked = ['docs/readme', 'src/file-extra', '[ab].txt']
      expect(partitionTrackedPathSpecs(requests, tracked, windowsPaths)).toEqual(
        windowsPaths
          ? { trackedPaths: ['docs\\', '[ab].txt', 'docs///'], untrackedPaths: ['new', 'src/file'] }
          : { trackedPaths: ['[ab].txt', 'docs///'], untrackedPaths: ['new', 'docs\\', 'src/file'] }
      )
    }
  )

  it('does not reuse tracked evidence across operations', () => {
    expect(partitionTrackedPathSpecs(['docs'], ['docs/file'], false).trackedPaths).toEqual(['docs'])
    expect(partitionTrackedPathSpecs(['docs'], [], false).untrackedPaths).toEqual(['docs'])
  })

  it('normalizes each visited tracked entry once and each request once per operation', () => {
    const requests = Array.from({ length: 64 }, (_, index) => `missing/${index}`)
    const tracked = Array.from({ length: 256 }, (_, index) => `docs\\file-${index}///`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(requests, tracked, true))).toBe(320)
  })

  it('retains early exit for a selected directory with many tracked descendants', () => {
    const tracked = Array.from({ length: 64 }, (_, index) => `docs/file-${index}`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(['docs'], tracked, true))).toBe(2)
    expect(countNormalizations(() => partitionTrackedPathSpecs([], tracked, true))).toBe(0)
  })
})
