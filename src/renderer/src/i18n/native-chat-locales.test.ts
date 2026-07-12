import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const localizedCatalogs = { es, ja, ko, zh }
const englishSetting = en.auto.components.settings.ExperimentalPane.nativeChat
const englishSearch = en.auto.components.settings.experimental.search.nativeChat

describe('native chat locale copy', () => {
  it.each(Object.entries(localizedCatalogs))(
    '%s keeps provider-neutral copy localized',
    (_code, catalog) => {
      const setting = catalog.auto.components.settings.ExperimentalPane.nativeChat
      const search = catalog.auto.components.settings.experimental.search.nativeChat
      for (const [localized, english] of [
        [setting.description, englishSetting.description],
        [setting.copy, englishSetting.copy],
        [setting.defaultCopy, englishSetting.defaultCopy],
        [search.description, englishSearch.description]
      ]) {
        expect(localized.trim()).not.toBe('')
        expect(localized).not.toBe(english)
      }
      expect(search.grok).toBe('grok')
    }
  )
})
