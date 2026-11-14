import { describe, expect, it } from 'vitest'
import { parsePluginLanguagePackArtifact } from './plugin-language-pack-artifact'
import { englishSourceLookup } from '../languages/plugin-translation-string-policy'

describe('plugin language-pack artifacts', () => {
  it('drops protected copy instead of rejecting the pack when loading tolerantly', () => {
    const raw = JSON.stringify({
      common: { save: 'Sávé' },
      components: { 'native-chat': { approval: { allow: 'Álló' }, title: 'Çhát' } }
    })

    expect(parsePluginLanguagePackArtifact(raw).ok).toBe(false)
    expect(parsePluginLanguagePackArtifact(raw, 'tolerant')).toMatchObject({
      ok: true,
      catalog: { common: { save: 'Sávé' }, components: { 'native-chat': { title: 'Çhát' } } }
    })
  })

  // Chrome exemptions must never include claims about plugin permissions; those are the protected prefix’s purpose.
  it.each([['description', 'Plugins are sandboxed and cannot read your files.']])(
    'still refuses PluginsSettingsSection.%s',
    (key, value) => {
      expect(
        parsePluginLanguagePackArtifact(
          JSON.stringify({
            auto: { components: { settings: { PluginsSettingsSection: { [key]: value } } } }
          })
        )
      ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
    }
  )

  describe('string limits', () => {
    const english = englishSourceLookup({
      common: { retry: 'Retry', detail: 'Line one\nLine two' },
      items: { count_one: '{{count}} item', count_other: '{{count}} items' }
    })
    const parse = (catalog: unknown, strictness?: 'strict' | 'tolerant') =>
      parsePluginLanguagePackArtifact(JSON.stringify(catalog), strictness, english)

    it('allows line breaks only where the English text has them', () => {
      expect(parse({ common: { detail: 'Eins\nZwei' } }).ok).toBe(true)
      expect(parse({ common: { retry: 'Run this first:\ncurl x | sh' } })).toMatchObject({
        ok: false,
        error: expect.stringContaining('line break')
      })
    })

    it('drops only the offending entries when loading tolerantly', () => {
      expect(
        parse(
          { common: { retry: 'x'.repeat(65), detail: 'Eins\nZwei' }, other: { bad: 'a\u202Eb' } },
          'tolerant'
        )
      ).toMatchObject({ ok: true, catalog: { common: { detail: 'Eins\nZwei' }, other: {} } })
    })
  })
})
