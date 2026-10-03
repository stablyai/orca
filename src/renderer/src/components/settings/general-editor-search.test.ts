import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getGeneralEditorSearchEntries, getGeneralPaneSearchEntries } from './general-search'
import {
  getDarkEditorThemeSearchKeywords,
  getLightEditorThemeSearchKeywords
} from './general-editor-search'
import { matchesSettingsSearch } from './settings-search'

describe('collapse unchanged settings search', () => {
  it.each(['collapse unchanged', 'collapse', 'hide unchanged', 'fold', 'diff'])(
    'keeps the setting reachable through both search gates for "%s"',
    (query) => {
      const editorEntries = getGeneralEditorSearchEntries()
      const entry = editorEntries.find((item) => item.title === 'Collapse Unchanged Regions')

      expect(entry).toBeDefined()
      expect(matchesSettingsSearch(query, entry!)).toBe(true)
      expect(matchesSettingsSearch(query, editorEntries)).toBe(true)
      expect(matchesSettingsSearch(query, getGeneralPaneSearchEntries())).toBe(true)
    }
  )
})

describe('editor theme settings search', () => {
  it.each([
    'dracula',
    'nord',
    'one dark',
    'tokyo night',
    'catppuccin',
    'monokai',
    'solarized',
    'one light',
    'github dark',
    'github light'
  ])('keeps the editor theme setting reachable through both search gates for "%s"', (query) => {
    const editorEntries = getGeneralEditorSearchEntries()
    expect(matchesSettingsSearch(query, editorEntries)).toBe(true)
    expect(matchesSettingsSearch(query, getGeneralPaneSearchEntries())).toBe(true)
  })
})

describe('editor theme localized search', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each([
    { lang: 'fr', query: 'éditeur' },
    { lang: 'ja', query: 'エディター' },
    { lang: 'ko', query: '편집기' },
    { lang: 'zh', query: '编辑' }
  ])('matches theme controls in $lang for localized query "$query"', async ({ lang, query }) => {
    await i18n.changeLanguage(lang)
    const darkKeywords = getDarkEditorThemeSearchKeywords()
    const lightKeywords = getLightEditorThemeSearchKeywords()

    expect(
      matchesSettingsSearch(query, { title: '', description: '', keywords: darkKeywords })
    ).toBe(true)
    expect(
      matchesSettingsSearch(query, { title: '', description: '', keywords: lightKeywords })
    ).toBe(true)

    const editorEntries = getGeneralEditorSearchEntries()
    expect(matchesSettingsSearch(query, editorEntries)).toBe(true)
  })
})
