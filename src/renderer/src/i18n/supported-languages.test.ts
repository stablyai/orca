import { describe, expect, it } from 'vitest'

import { UI_LANGUAGE_CHINESE, UI_LANGUAGE_CHINESE_TRADITIONAL } from '../../../shared/ui-language'
import en from './locales/en.json'
import { UI_LANGUAGE_CHOICES, getUiLanguageChoiceLabel } from './supported-languages'

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? Reflect.get(node, part) : undefined),
      catalog
    )
}

describe('UI_LANGUAGE_CHOICES', () => {
  it('offers Traditional Chinese right after Simplified Chinese', () => {
    const values = UI_LANGUAGE_CHOICES.map((choice) => choice.value)
    expect(values.indexOf(UI_LANGUAGE_CHINESE_TRADITIONAL)).toBe(
      values.indexOf(UI_LANGUAGE_CHINESE) + 1
    )
  })

  it('labels Traditional Chinese with its own name', () => {
    const choice = UI_LANGUAGE_CHOICES.find(
      (entry) => entry.value === UI_LANGUAGE_CHINESE_TRADITIONAL
    )
    if (!choice) {
      throw new Error('Traditional Chinese choice is missing')
    }
    expect(getUiLanguageChoiceLabel(choice, (_key, fallback) => fallback)).toBe('中文（繁體）')
  })

  it('has an English catalog entry for every choice label', () => {
    for (const choice of UI_LANGUAGE_CHOICES) {
      expect(typeof lookup(en, choice.labelKey), choice.labelKey).toBe('string')
    }
  })
})
