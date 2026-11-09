import { describe, expect, it } from 'vitest'
import {
  buildExcludePathPrefixes,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath
} from './quick-open-filter'

describe('buildExcludePathPrefixes', () => {
  it('keeps dot-dot-prefixed names inside the root while rejecting parent escapes', () => {
    expect(
      buildExcludePathPrefixes('/home/u/repo', [
        '/home/u/repo/..env',
        '/home/u/repo/..workspace/app',
        '/home/u/repo/../outside'
      ])
    ).toEqual(['..env', '..workspace/app'])
  })
})

describe('shouldExcludeQuickOpenRelPath', () => {
  it('preserves normalized Windows and UNC exclusion boundaries', () => {
    for (const [root, excluded] of [
      ['C:\\Repo', 'C:\\Repo\\trees\\one'],
      ['\\\\server\\share\\repo', '\\\\server\\share\\repo\\trees\\one']
    ]) {
      const prefixes = buildExcludePathPrefixes(root, [excluded])
      expect(prefixes).toEqual(['trees/one'])
      expect(shouldExcludeQuickOpenRelPath('trees/one/file.ts', prefixes)).toBe(true)
      expect(shouldExcludeQuickOpenRelPath('trees/one-more/file.ts', prefixes)).toBe(false)
    }
  })

  it('does not match sibling paths with a shared prefix', () => {
    expect(shouldExcludeQuickOpenRelPath('packages/app2/x.ts', ['packages/app'])).toBe(false)
    expect(shouldExcludeQuickOpenRelPath('packages/application', ['packages/app'])).toBe(false)
  })
})

describe('normalizeQuickOpenRgLine', () => {
  it('keeps cwd-relative dot-dot-prefixed names but rejects parent escapes', () => {
    expect(normalizeQuickOpenRgLine('./..fixtures/a.ts', { kind: 'cwd-relative' })).toBe(
      '..fixtures/a.ts'
    )
    expect(normalizeQuickOpenRgLine('..env', { kind: 'cwd-relative' })).toBe('..env')
    expect(normalizeQuickOpenRgLine('..workspace/file.ts', { kind: 'cwd-relative' })).toBe(
      '..workspace/file.ts'
    )
    expect(normalizeQuickOpenRgLine('../outside.ts', { kind: 'cwd-relative' })).toBeNull()
    expect(normalizeQuickOpenRgLine('..', { kind: 'cwd-relative' })).toBeNull()
  })

  it('preserves a trailing carriage return in a NUL-delimited filename', () => {
    expect(normalizeQuickOpenRgLine('/root/a.ts\r', { kind: 'absolute', rootPath: '/root' })).toBe(
      'a.ts\r'
    )
  })
})
