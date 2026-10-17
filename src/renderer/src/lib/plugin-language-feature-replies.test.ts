import { describe, expect, it } from 'vitest'
import {
  parseHover,
  parseLocations,
  workspaceRelativeTarget
} from './plugin-language-feature-replies'

const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }

describe('plugin language feature replies', () => {
  it('keeps a hover and drops a malformed range', () => {
    expect(parseHover({ contents: 'x', range })).toEqual({ contents: 'x', range })
    expect(parseHover({ contents: 'x', range: { startLineNumber: 0 } })).toEqual({
      contents: 'x',
      range: undefined
    })
    expect(parseHover({ contents: 42 })).toBeNull()
    expect(parseHover(null)).toBeNull()
  })

  it('keeps only well-formed locations', () => {
    expect(
      parseLocations([
        { filePath: '/repo/a.ts', range },
        { filePath: '', range },
        { filePath: '/repo/b.ts', range: { ...range, endColumn: 1.5 } },
        'junk'
      ])
    ).toEqual([{ filePath: '/repo/a.ts', range }])
    expect(parseLocations({ filePath: '/repo/a.ts', range })).toEqual([])
  })

  it('only follows targets inside the source tab workspace', () => {
    const tab = { filePath: '/repo/src/a.ts', relativePath: 'src/a.ts' }
    expect(workspaceRelativeTarget(tab, '/repo/lib/b.ts')).toBe('lib/b.ts')
    expect(workspaceRelativeTarget(tab, '/repo/../etc/passwd')).toBeNull()
    expect(workspaceRelativeTarget(tab, '/repo/src/./a.ts')).toBeNull()
    expect(workspaceRelativeTarget(tab, '/repo-other/b.ts')).toBeNull()
    expect(workspaceRelativeTarget(tab, '/home/me/.ssh/id_rsa')).toBeNull()
    expect(workspaceRelativeTarget(tab, '/repo/')).toBeNull()
    // A tab outside any workspace has no root to trust.
    expect(
      workspaceRelativeTarget({ filePath: '/tmp/x.ts', relativePath: '/tmp/x.ts' }, '/tmp/y.ts')
    ).toBeNull()
  })

  it('handles Windows separators', () => {
    const tab = { filePath: 'C:\\repo\\src\\a.ts', relativePath: 'src\\a.ts' }
    expect(workspaceRelativeTarget(tab, 'C:\\repo\\lib\\b.ts')).toBe('lib\\b.ts')
    expect(workspaceRelativeTarget(tab, 'C:\\repo\\..\\secret.txt')).toBeNull()
  })
})
