/**
 * The empty state used to render as three sibling nodes: a `No settings found for "`
 * fragment, the raw query, then a `"` fragment. Only languages that put the quoted
 * term last read correctly that way. Korean and Chinese put it first, so their
 * translators localized the leading fragment as a whole clause and the query landed
 * after the sentence had ended: `"에 대한 설정을 찾을 수 없습니다.screen reader"`.
 *
 * No prefix/suffix split can serve both word orders, so the message is one entry with
 * a `{{value0}}` placeholder and each locale positions the term itself. The expected
 * messages below are the assertion: ko and zh carry text *after* the query, which is
 * exactly what the old shape could not express.
 */
import { describe, expect, it } from 'vitest'

import { i18n, translate } from './i18n'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const KEY = 'auto.components.settings.Settings.noSettingsFoundForQuery'
const FALLBACK = 'No settings found for "{{value0}}"'
const RETIRED_FRAGMENT_KEYS = [
  'auto.components.settings.Settings.3c88ec55d6',
  'auto.components.settings.Settings.add3b97ee6'
]
const QUERY = 'screen reader'

const CATALOGS: Record<string, unknown> = { en, es, fr, ja, ko, zh }

const EXPECTED_MESSAGES: Record<string, string> = {
  en: 'No settings found for "screen reader"',
  es: 'No se encontraron configuraciones para "screen reader"',
  fr: 'Aucun paramètre trouvé pour "screen reader"',
  ja: '検索条件に一致する設定が見つかりませんでした:「screen reader」',
  ko: '"screen reader"에 대한 설정을 찾을 수 없습니다.',
  zh: '找不到“screen reader”的设置'
}

function lookup(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' && !Array.isArray(node)
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog
    )
  return typeof value === 'string' ? value : undefined
}

describe('settings search empty-state message', () => {
  it('declares one interpolated message instead of prefix and suffix fragments', () => {
    expect(lookup(en, KEY)).toBe(FALLBACK)
    for (const retired of RETIRED_FRAGMENT_KEYS) {
      for (const [locale, catalog] of Object.entries(CATALOGS)) {
        expect(lookup(catalog, retired), `${locale}: ${retired}`).toBeUndefined()
      }
    }
  })

  it.each(Object.entries(EXPECTED_MESSAGES))(
    'renders %s as one sentence with the query inside the quotes',
    async (locale, expected) => {
      await i18n.changeLanguage(locale)
      expect(translate(KEY, FALLBACK, { value0: QUERY })).toBe(expected)
    }
  )
})
