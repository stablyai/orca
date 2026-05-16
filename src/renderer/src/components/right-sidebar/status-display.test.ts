import { describe, expect, it } from 'vitest'
import { buildIgnoredSet, isPathIgnored, shouldShowIgnoredDecoration } from './status-display'

describe('buildIgnoredSet', () => {
  it('returns an empty set when ignoredPaths is undefined', () => {
    expect(buildIgnoredSet(undefined).size).toBe(0)
  })

  it('strips trailing slash from directory entries so lookups by TreeNode.relativePath hit', () => {
    const set = buildIgnoredSet(['dist/', 'node_modules/', '.env'])
    expect(set.has('dist')).toBe(true)
    expect(set.has('node_modules')).toBe(true)
    expect(set.has('.env')).toBe(true)
    expect(set.has('dist/')).toBe(false)
  })
})

describe('isPathIgnored', () => {
  it('returns false on an empty set without walking ancestors', () => {
    expect(isPathIgnored(new Set(), 'a/b/c.ts')).toBe(false)
  })

  it('matches direct hits', () => {
    expect(isPathIgnored(new Set(['.env']), '.env')).toBe(true)
  })

  it('inherits ignored status from an ancestor directory', () => {
    const ignored = new Set(['dist'])
    expect(isPathIgnored(ignored, 'dist/index.js')).toBe(true)
    expect(isPathIgnored(ignored, 'dist/sub/deep/file.js')).toBe(true)
  })

  it('does not match sibling paths that share a prefix', () => {
    const ignored = new Set(['dist'])
    expect(isPathIgnored(ignored, 'distance.ts')).toBe(false)
  })
})

describe('shouldShowIgnoredDecoration', () => {
  it('shows ignored decoration only when no real git status exists', () => {
    const ignored = new Set(['dist'])

    expect(shouldShowIgnoredDecoration(null, ignored, 'dist/index.js')).toBe(true)
    expect(shouldShowIgnoredDecoration('modified', ignored, 'dist/index.js')).toBe(false)
    expect(shouldShowIgnoredDecoration('untracked', ignored, 'dist/index.js')).toBe(false)
  })
})
