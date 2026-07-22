import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_THAI } from '../../../../shared/ui-language'
import { KEYBINDING_DEFINITIONS } from '../../../../shared/keybindings'
import {
  getLocalizedKeybindingDefinition,
  getLocalizedKeybindingDefinitions,
  getLocalizedKeybindingGroupTitle,
  getLocalizedKeybindingGroupTitles,
  getLocalizedKeybindingTitle
} from './keybinding-copy'

describe('keybinding-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns exactly as many localized definitions as the raw shared source', () => {
    expect(getLocalizedKeybindingDefinitions()).toHaveLength(KEYBINDING_DEFINITIONS.length)
  })

  it('returns exactly as many localized group titles as there are distinct raw groups', () => {
    const rawGroupCount = new Set(KEYBINDING_DEFINITIONS.map((definition) => definition.group)).size
    expect(getLocalizedKeybindingGroupTitles()).toHaveLength(rawGroupCount)
  })

  it('falls back to the raw English title and group text by default', () => {
    for (const definition of KEYBINDING_DEFINITIONS) {
      expect(getLocalizedKeybindingDefinition(definition.id)?.title).toBe(definition.title)
      expect(getLocalizedKeybindingTitle(definition)).toBe(definition.title)
      expect(getLocalizedKeybindingGroupTitle(definition.group)).toBe(definition.group)
    }
  })

  it('returns null for an unknown action id', () => {
    expect(getLocalizedKeybindingDefinition('not.a.real.action' as never)).toBeNull()
  })

  it('falls back to the raw string when a group has never been seen', () => {
    expect(getLocalizedKeybindingGroupTitle('Not A Real Group')).toBe('Not A Real Group')
  })

  it('does not throw and still returns a sane value after switching UI language', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_THAI)
    expect(() => getLocalizedKeybindingDefinitions()).not.toThrow()
    expect(() => getLocalizedKeybindingGroupTitles()).not.toThrow()
    const definitions = getLocalizedKeybindingDefinitions()
    expect(definitions).toHaveLength(KEYBINDING_DEFINITIONS.length)
    for (const definition of definitions) {
      expect(typeof definition.title).toBe('string')
      expect(definition.title.length).toBeGreaterThan(0)
    }
    const groupTitles = getLocalizedKeybindingGroupTitles()
    for (const entry of groupTitles) {
      expect(typeof entry.title).toBe('string')
      expect(entry.title.length).toBeGreaterThan(0)
    }
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
