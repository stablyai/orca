import { describe, expect, it } from 'vitest'
import { getGeneralEditorSearchEntries, getGeneralPaneSearchEntries } from './general-search'
import { matchesSettingsSearch } from './settings-search'

describe('editor font size settings search', () => {
  it.each(['editor font size', 'font size', 'text size', 'editor'])(
    'keeps the setting reachable through both search gates for "%s"',
    (query) => {
      const editorEntries = getGeneralEditorSearchEntries()
      const entry = editorEntries.find((item) => item.title === 'Editor Font Size')

      expect(entry).toBeDefined()
      expect(matchesSettingsSearch(query, entry!)).toBe(true)
      expect(matchesSettingsSearch(query, editorEntries)).toBe(true)
      expect(matchesSettingsSearch(query, getGeneralPaneSearchEntries())).toBe(true)
    }
  )
})
