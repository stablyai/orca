import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { scoreSettingsSearch } from '../search/settings-search'
import { getChatBehaviorEntriesByKey } from './chat-behavior-search'

describe('Suggested prompts settings search in Russian', () => {
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

  it.each(['промпт', 'следующий промпт', 'следующий запрос', 'next prompt'])(
    'finds the setting for %s',
    (query) => {
      const entry = getChatBehaviorEntriesByKey().promptSuggestions
      expect(entry.title).toBe('Предлагаемые запросы')
      expect(scoreSettingsSearch(query, entry, { firstEntryIsPane: false })).toBeGreaterThan(0)
    }
  )
})
