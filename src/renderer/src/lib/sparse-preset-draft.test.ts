import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { parseSparsePresetDirectories, validateSparsePresetName } from './sparse-preset-draft'

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

describe('validateSparsePresetName', () => {
  const presets = [{ id: 'web', name: 'Web UI' }]
  it('validates required, length, duplicate, and unchanged names', () => {
    expect(validateSparsePresetName(' ', presets)).toBe('Name is required.')
    expect(validateSparsePresetName('a'.repeat(81), presets)).toBe(
      'Name must be 80 characters or fewer.'
    )
    expect(validateSparsePresetName(' web ui ', presets)).toBe(
      'A preset named “Web UI” already exists.'
    )
    expect(validateSparsePresetName('Web UI', presets, 'web')).toBeNull()
    expect(validateSparsePresetName('a'.repeat(80), presets)).toBeNull()
  })
  it('uses Korean validation with a named interpolation', async () => {
    await setRendererUiLanguage('ko')
    try {
      expect(validateSparsePresetName('', presets)).toBe('이름을 입력하세요.')
      expect(validateSparsePresetName('a'.repeat(81), presets)).toBe('이름은 80자 이하여야 합니다.')
      expect(validateSparsePresetName('web ui', presets)).toBe(
        '같은 이름의 프리셋이 이미 있습니다: Web UI'
      )
    } finally {
      await setRendererUiLanguage('en')
    }
  })
})
