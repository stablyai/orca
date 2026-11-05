import { describe, expect, it } from 'vitest'
import { splitPathForDisplay } from './editor-path-display'

describe('splitPathForDisplay', () => {
  it.each([
    ['/repo/src/file.ts', { prefix: '/repo/src/', fileName: 'file.ts' }],
    ['C:\\repo\\src\\file.ts', { prefix: 'C:\\repo\\src\\', fileName: 'file.ts' }],
    ['file.ts', { prefix: '', fileName: 'file.ts' }]
  ])('keeps the final filename separate for %s', (path, expected) => {
    expect(splitPathForDisplay(path)).toEqual(expected)
  })
})
