import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import enRuntimeRequired from './en-runtime-required.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const settings = en.auto.components.settings
const browser = en.auto.components.sidebar.RemoteFileBrowser
const messages = [
  ...Object.entries(settings.GitHubRepositoryPicker).map(
    ([key, value]) => [`auto.components.settings.GitHubRepositoryPicker.${key}`, value] as const
  ),
  ...Object.entries(settings.RepositoryHostCloneStep).map(
    ([key, value]) => [`auto.components.settings.RepositoryHostCloneStep.${key}`, value] as const
  ),
  ...(['55216d346f', '7194618895'] as const).map(
    (key) => [`auto.components.sidebar.RemoteFileBrowser.${key}`, browser[key]] as const
  )
]

describe('cross-host clone sparse locale catalogs', () => {
  it.each(Object.entries({ es, ja, ko, zh }))(
    '%s keeps untranslated clone copy out of the target catalog and renders its fallback',
    async (locale, catalog) => {
      const instance = i18next.createInstance()
      await instance.init({
        lng: locale,
        fallbackLng: 'en',
        resources: {
          en: { translation: enRuntimeRequired },
          [locale]: { translation: catalog }
        },
        interpolation: { escapeValue: false }
      })

      expect(messages).toHaveLength(17)
      for (const [key, defaultValue] of messages) {
        const localized = instance.getResource(locale, 'translation', key)
        expect(localized, `${locale}:${key} must not contain copied English`).not.toBe(defaultValue)
        // Real translations may arrive later; absent entries must use the live English default.
        if (localized === undefined) {
          expect(instance.t(key, { defaultValue, path: '/work/orca', value0: '/work' })).toBe(
            defaultValue.replace('{{path}}', '/work/orca').replace('{{value0}}', '/work')
          )
        }
      }
    }
  )
})
