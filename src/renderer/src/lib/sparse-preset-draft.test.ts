import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSparsePresetDirectories } from './sparse-preset-draft'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseSparsePresetDirectories', () => {
  it('normalizes textarea input into unique repo-relative directories', () => {
    expect(
      parseSparsePresetDirectories(`
        src\\renderer
        packages/ui/
        src/renderer
      `)
    ).toEqual({
      directories: ['src/renderer', 'packages/ui'],
      error: null
    })
  })

  it('requires at least one directory', () => {
    expect(parseSparsePresetDirectories(' \n ')).toEqual({
      directories: [],
      error: 'Add at least one directory.'
    })
  })

  it('rejects root and parent path entries', () => {
    expect(parseSparsePresetDirectories('.')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
    expect(parseSparsePresetDirectories('src/../packages')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
    expect(parseSparsePresetDirectories('/')).toEqual({
      directories: [],
      error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
    })
  })

  it.each(['/Users/me/repo/packages/web', 'C:\\repo\\packages\\web', '\\\\server\\share\\repo'])(
    'rejects absolute directory input before normalization: %s',
    (entry) => {
      expect(parseSparsePresetDirectories(entry)).toEqual({
        directories: [],
        error: 'Use repo-relative directories, not root, absolute paths, or parent segments.'
      })
    }
  )

  it('normalizes newline-heavy pasted directory input without splitting the full textarea', () => {
    const value = `${'\n'.repeat(1000)}src\\renderer\npackages/ui\nsrc/renderer\n`
    const split = vi.spyOn(String.prototype, 'split')

    expect(parseSparsePresetDirectories(value)).toEqual({
      directories: ['src/renderer', 'packages/ui'],
      error: null
    })
    expect(split).not.toHaveBeenCalled()
  })
})
