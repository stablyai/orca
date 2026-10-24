import { expect, it } from 'vitest'
import type { GlobalSettings } from '../global-settings-types'
import { fileTypeOfPath, normalizePluginFileTypeSuggestionSettings } from './plugin-file-type'

it('reads the last extension of a path in lowercase', () => {
  expect(fileTypeOfPath('docs/Paper.TYP')).toBe('typ')
  expect(fileTypeOfPath('C:\\repo\\archive.tar.gz')).toBe('gz')
  expect(fileTypeOfPath('repo/.gitignore')).toBeNull()
  expect(fileTypeOfPath('repo/Makefile')).toBeNull()
  expect(fileTypeOfPath('repo/odd.ext with space')).toBeNull()
})

it('bounds the suggestion settings', () => {
  expect(
    normalizePluginFileTypeSuggestionSettings({
      pluginFileTypeSuggestions: 'yes',
      pluginDismissedFileTypes: ['typ', 'typ', '.bad', 7, 'x'.repeat(40)]
    })
  ).toEqual({ pluginFileTypeSuggestions: true, pluginDismissedFileTypes: ['typ'] })
  expect(normalizePluginFileTypeSuggestionSettings({ pluginFileTypeSuggestions: false })).toEqual({
    pluginFileTypeSuggestions: false
  })
  const unrelated: Partial<GlobalSettings> = { theme: 'dark' }
  expect(normalizePluginFileTypeSuggestionSettings(unrelated)).toEqual({})
  const full = Array.from({ length: 256 }, (_, index) => `t${index}`)
  expect(
    normalizePluginFileTypeSuggestionSettings({
      pluginDismissedFileTypes: [...full, 'gleam']
    }).pluginDismissedFileTypes?.at(-1)
  ).toBe('gleam')
})
