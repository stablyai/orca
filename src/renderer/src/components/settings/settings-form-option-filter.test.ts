import { describe, expect, it } from 'vitest'
import type { TerminalThemeOption } from '@/lib/terminal-theme'
import {
  SETTINGS_FORM_OPTION_QUERY_MAX_BYTES,
  filterFontSuggestions,
  filterTerminalThemeOptions,
  isSettingsFormOptionQueryTooLarge
} from './settings-form-option-filter'

function createThemeOption(
  label: string,
  group: TerminalThemeOption['group'] = 'built-in',
  sourceLabel?: string
): TerminalThemeOption {
  return {
    value: label,
    label,
    group,
    sourceLabel,
    previewTheme: null
  }
}

describe('settings-form-option-filter', () => {
  it('filters terminal themes by label and source label', () => {
    const themes = [
      createThemeOption('Solarized Dark'),
      createThemeOption('Night Owl', 'imported', 'Imported from Ghostty'),
      createThemeOption('Tango Light')
    ]

    expect(filterTerminalThemeOptions(themes, 'ghostty')).toEqual([themes[1]])
    expect(filterTerminalThemeOptions(themes, ' dark ')).toEqual([themes[0]])
  })

  it('orders font suggestions by prefix matches before substring matches', () => {
    expect(filterFontSuggestions(['Fira Code', 'Cascadia Code', 'Code New Roman'], 'code')).toEqual(
      ['Code New Roman', 'Fira Code', 'Cascadia Code']
    )
  })

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(SETTINGS_FORM_OPTION_QUERY_MAX_BYTES)

    expect(query.length).toBe(SETTINGS_FORM_OPTION_QUERY_MAX_BYTES)
    expect(isSettingsFormOptionQueryTooLarge(query)).toBe(true)
    expect(filterTerminalThemeOptions([createThemeOption('Solarized Dark')], query)).toEqual([])
    expect(filterFontSuggestions(['Fira Code'], query)).toEqual([])
  })

  it('rejects oversized theme queries before reading option labels', () => {
    const oversizedQuery = 'secret-terminal-theme-search'.repeat(
      SETTINGS_FORM_OPTION_QUERY_MAX_BYTES
    )
    const theme = {
      value: 'theme',
      group: 'built-in',
      previewTheme: null,
      get label(): string {
        throw new Error('oversized theme searches must not scan labels')
      },
      get sourceLabel(): string {
        throw new Error('oversized theme searches must not scan sources')
      }
    } as TerminalThemeOption

    expect(isSettingsFormOptionQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterTerminalThemeOptions([theme], oversizedQuery)).toEqual([])
  })

  it('rejects oversized font queries before reading suggestion text', () => {
    const oversizedQuery = 'secret-font-search'.repeat(SETTINGS_FORM_OPTION_QUERY_MAX_BYTES)
    const font = {
      toLowerCase(): string {
        throw new Error('oversized font searches must not scan font names')
      }
    } as unknown as string

    expect(isSettingsFormOptionQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterFontSuggestions([font], oversizedQuery)).toEqual([])
  })

  it('rejects oversized whitespace before trimming option filters', () => {
    const query = ' '.repeat(SETTINGS_FORM_OPTION_QUERY_MAX_BYTES + 1)

    expect(filterTerminalThemeOptions([createThemeOption('Solarized Dark')], query)).toEqual([])
    expect(filterFontSuggestions(['Fira Code'], query)).toEqual([])
  })
})
