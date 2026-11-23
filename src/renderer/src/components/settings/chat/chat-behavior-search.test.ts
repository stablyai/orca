import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { scoreSettingsSearch } from '../search/settings-search'
import { getChatBehaviorEntriesByKey } from './chat-behavior-search'

const QUERIES = ['промпт', 'следующий промпт', 'следующий запрос', 'next prompt']

// Declared first: runs before the pinned-glossary block below mutates the Russian bundle.
describe('Suggested prompts settings search with the shipped Russian catalog', () => {
  beforeAll(async () => {
    await setRendererUiLanguage('ru')
  })

  afterAll(async () => {
    await setRendererUiLanguage('en')
  })

  it.each(QUERIES)('finds the setting for %s', (query) => {
    const entry = getChatBehaviorEntriesByKey().promptSuggestions
    expect(scoreSettingsSearch(query, entry, { firstEntryIsPane: false })).toBeGreaterThan(0)
  })
})

describe('Suggested prompts settings search with the «запрос» glossary wording', () => {
  beforeAll(async () => {
    await setRendererUiLanguage('ru')
    // Pin the glossary wording («запрос») so the legacy «промпт» wording only matches via aliases.
    i18n.addResourceBundle(
      'ru',
      'translation',
      {
        components: {
          settings: {
            nativeChat: {
              promptSuggestionsTitle: 'Предлагаемые запросы',
              promptSuggestionsSearchNext: 'следующий запрос'
            }
          }
        }
      },
      true,
      true
    )
  })

  afterAll(async () => {
    await setRendererUiLanguage('en')
  })

  it.each(QUERIES)('finds the setting for %s', (query) => {
    const entry = getChatBehaviorEntriesByKey().promptSuggestions
    expect(entry.title).toBe('Предлагаемые запросы')
    expect(scoreSettingsSearch(query, entry, { firstEntryIsPane: false })).toBeGreaterThan(0)
  })
})
