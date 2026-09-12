/**
 * A plugin pack registers under a synthetic `plugin<hex>` resource language,
 * which i18next cannot turn into `Intl.PluralRules`, so plural selection falls
 * back to two English forms. These tests pin that the declared locale is what
 * decides the form, and that resource lookup still runs on the synthetic tag.
 */
import { describe, expect, it } from 'vitest'
import i18next, { type i18n as I18nInstance } from 'i18next'
import {
  pluginLanguageResourceId,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'
import { applyPluginPluralLocales, pluralLocaleForResourceLanguage } from './plugin-plural-locale'

const RESOURCE_LANGUAGE = pluginLanguageResourceId('plugin:smwbev.russian')

// Russian needs four categories where English has two: `2 сессии` (few) and
// `5 сессий` (many) are different words, and both differ from `1 сессия`.
const RUSSIAN_CATALOG = {
  sessions_one: '{{count}} сессия',
  sessions_few: '{{count}} сессии',
  sessions_many: '{{count}} сессий',
  sessions_other: '{{count}} сессии'
}

function pack(locale: string): PluginLanguagePackRegistration {
  return {
    id: 'plugin:smwbev.russian',
    resourceLanguage: RESOURCE_LANGUAGE,
    pluginKey: 'smwbev.russian',
    locale,
    catalog: RUSSIAN_CATALOG
  }
}

async function instanceWithPack(): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance.init({
    lng: 'en',
    resources: {
      en: {
        translation: { sessions_one: '{{count}} session', sessions_other: '{{count}} sessions' }
      },
      [RESOURCE_LANGUAGE]: { translation: RUSSIAN_CATALOG }
    }
  })
  return instance
}

function render(instance: I18nInstance, counts: number[]): string[] {
  return counts.map((count) => instance.t('sessions', { lng: RESOURCE_LANGUAGE, count }))
}

describe('plugin pack plural rules', () => {
  it('selects Russian forms once the pack declares its locale', async () => {
    const instance = await instanceWithPack()

    expect(render(instance, [1, 2, 5, 21])).toEqual([
      '1 сессия',
      '2 сессии',
      '5 сессии',
      '21 сессии'
    ])

    applyPluginPluralLocales(instance, [pack('ru-RU')])

    expect(render(instance, [1, 2, 5, 21])).toEqual([
      '1 сессия',
      '2 сессии',
      '5 сессий',
      '21 сессия'
    ])
  })

  it('keeps resource lookup on the synthetic tag', async () => {
    const instance = await instanceWithPack()
    applyPluginPluralLocales(instance, [pack('ru-RU')])

    // A key with no plural forms still resolves from the pack's own bundle.
    instance.addResourceBundle(RESOURCE_LANGUAGE, 'translation', { plain: 'Настройки' }, true, true)

    expect(instance.t('plain', { lng: RESOURCE_LANGUAGE })).toBe('Настройки')
    expect(instance.t('sessions', { lng: 'en', count: 5 })).toBe('5 sessions')
  })

  it('ignores a pack whose locale is missing or already the resource language', async () => {
    const instance = await instanceWithPack()

    applyPluginPluralLocales(instance, [pack('')])
    expect(pluralLocaleForResourceLanguage(RESOURCE_LANGUAGE)).toBeUndefined()
    expect(render(instance, [5])).toEqual(['5 сессии'])

    applyPluginPluralLocales(instance, [pack(RESOURCE_LANGUAGE)])
    expect(pluralLocaleForResourceLanguage(RESOURCE_LANGUAGE)).toBeUndefined()
  })

  it('canonicalizes a declared locale that Intl would otherwise reject', async () => {
    const instance = await instanceWithPack()

    // `ru_RU` and `RU-ru` are ordinary manifest slips; both name Russian.
    applyPluginPluralLocales(instance, [pack('ru_RU')])
    expect(pluralLocaleForResourceLanguage(RESOURCE_LANGUAGE)).toBe('ru-RU')
    expect(render(instance, [5])).toEqual(['5 сессий'])

    applyPluginPluralLocales(instance, [pack('RU-ru')])
    expect(pluralLocaleForResourceLanguage(RESOURCE_LANGUAGE)).toBe('ru-RU')
    expect(render(instance, [5])).toEqual(['5 сессий'])
  })

  it('ignores a locale Intl cannot resolve instead of inheriting the host locale', async () => {
    const instance = await instanceWithPack()

    // `not_a_locale` is malformed; `xx` and `tlh` are well-formed but carry no
    // CLDR data, and Intl answers those with the host machine's locale — so the
    // rendered forms would depend on whose computer the pack runs on.
    for (const declared of ['not_a_locale', 'xx', 'tlh']) {
      applyPluginPluralLocales(instance, [pack(declared)])
      expect(pluralLocaleForResourceLanguage(RESOURCE_LANGUAGE)).toBeUndefined()
      expect(render(instance, [1, 5])).toEqual(['1 сессия', '5 сессии'])
    }
  })

  it('follows a pack that changes its declared locale', async () => {
    const instance = await instanceWithPack()

    applyPluginPluralLocales(instance, [pack('ru-RU')])
    expect(render(instance, [5])).toEqual(['5 сессий'])

    // Japanese has a single category, so every count takes `_other`.
    applyPluginPluralLocales(instance, [pack('ja-JP')])
    expect(render(instance, [1, 5])).toEqual(['1 сессии', '5 сессии'])

    applyPluginPluralLocales(instance, [])
    expect(render(instance, [5])).toEqual(['5 сессии'])
  })
})
