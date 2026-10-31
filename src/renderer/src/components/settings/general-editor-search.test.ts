import { describe, expect, it } from 'vitest'

import { getGeneralEditorSearchEntries } from './general-editor-search'
import { matchesSettingsSearch } from './settings-search'

describe('getGeneralEditorSearchEntries', () => {
  it('keeps the editor keybindings entry searchable by vim and keybindings', () => {
    const entries = getGeneralEditorSearchEntries()

    expect(matchesSettingsSearch('vim', entries)).toBe(true)
    expect(matchesSettingsSearch('keybindings', entries)).toBe(true)
  })
})
