import { afterEach, describe, expect, it } from 'vitest'
import { i18n, setRendererPluginLanguagePacks } from '@/i18n/i18n'
import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'
import {
  getCodeBlockLanguageLabel,
  getCodeBlockLanguages,
  isKnownCodeBlockLanguage
} from './rich-markdown-code-block-languages'

afterEach(async () => {
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage('en')
})

describe('rich markdown code block languages', () => {
  it('caches the resolved list so repeated renders skip i18next lookups', () => {
    expect(getCodeBlockLanguages()).toBe(getCodeBlockLanguages())
  })

  it('refreshes cached labels when a plugin replaces the active resource bundle', async () => {
    const id = 'plugin:test.rich-markdown-languages' as const
    const resourceLanguage = pluginLanguageResourceId(id)
    const pack = (plainText: string) => ({
      id,
      resourceLanguage,
      pluginKey: 'test.rich-markdown-languages',
      locale: 'en',
      catalog: {
        auto: {
          components: {
            editor: { RichMarkdownCodeBlock: { '13822cdfda': plainText } }
          }
        }
      }
    })
    setRendererPluginLanguagePacks([pack('Plugin plain text')])
    await i18n.changeLanguage(resourceLanguage)
    const firstLanguages = getCodeBlockLanguages()

    setRendererPluginLanguagePacks([pack('Updated plugin plain text')])

    expect(getCodeBlockLanguages()).not.toBe(firstLanguages)
    expect(getCodeBlockLanguageLabel('')).toBe('Updated plugin plain text')
  })

  it('exposes a plain-text entry for unset fences and never blank labels', () => {
    const languages = getCodeBlockLanguages()

    expect(languages.some((language) => language.value === '')).toBe(true)
    expect(languages.every((language) => language.label.length > 0)).toBe(true)
  })

  it('labels known languages and passes unknown fences through verbatim', () => {
    expect(getCodeBlockLanguageLabel('')).toBe('Plain text')
    expect(getCodeBlockLanguageLabel('rust')).toBe('Rust')
    expect(getCodeBlockLanguageLabel('c')).toBe('C')
    // Why: a fence may name any language; the collapsed <select> still has to show it.
    expect(getCodeBlockLanguageLabel('brainfuck')).toBe('brainfuck')
  })

  it('reports membership for the unknown-language fallback option', () => {
    expect(isKnownCodeBlockLanguage('rust')).toBe(true)
    expect(isKnownCodeBlockLanguage('brainfuck')).toBe(false)
  })
})
