import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererPluginLanguagePacks, translate } from './i18n'
import { pluginLanguageResourceId } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { DEFAULT_LOCALE } from './supported-languages'

const PACK_ID = 'plugin:smwbev.russian/ru-RU' as const
const PACK_RESOURCE = pluginLanguageResourceId(PACK_ID)
const CATALOG = { files_one: 'one', files_few: 'few', files_many: 'many', files_other: 'other' }

async function activatePack(
  locale: string,
  catalog: Record<string, string> = CATALOG
): Promise<void> {
  setRendererPluginLanguagePacks([
    {
      id: PACK_ID,
      resourceLanguage: PACK_RESOURCE,
      pluginKey: 'smwbev.russian',
      locale,
      catalog,
      coverage: 100
    }
  ])
  await i18n.changeLanguage(PACK_RESOURCE)
}

function forms(counts: number[]): string[] {
  return counts.map((count) => i18n.t('files', { count }))
}

afterEach(async () => {
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

describe('plugin pack plurals', () => {
  it('selects plural forms by the locale the pack declares', async () => {
    await activatePack('ru-RU')
    expect(forms([1, 2, 5, 21])).toEqual(['one', 'few', 'many', 'one'])
  })

  it('keeps packs with only _one/_other in-language for few/many counts', async () => {
    await activatePack('ru-RU', { files_one: 'one', files_other: 'other' })
    expect(forms([1, 2, 5, 21])).toEqual(['one', 'other', 'other', 'one'])
  })

  it('resolves native plural calls through the pack locale plural rules', async () => {
    const label = (count: number): string =>
      translate('files', '{{count}} files', { count, defaultValue_one: '{{count}} file' })
    await activatePack('ru-RU')
    expect([1, 2, 5, 21].map(label)).toEqual(['one', 'few', 'many', 'one'])
  })
})
