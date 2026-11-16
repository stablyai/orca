import { expect, it } from 'vitest'
import { recommendedLanguagePack } from './language-pack-options'

it('prefers a regional translation over an earlier generic pack', () => {
  const packs = [
    { locale: 'pt', id: 'generic' },
    { locale: 'pt-PT', id: 'portugal' }
  ]
  expect(recommendedLanguagePack(packs, 'pt_PT.UTF-8')?.id).toBe('portugal')
})

it('does not recommend the wrong writing system when a device specifies a script', () => {
  const packs = [
    { locale: 'sr-Cyrl', id: 'cyrillic' },
    { locale: 'sr-Latn', id: 'latin' }
  ]
  expect(recommendedLanguagePack(packs, 'sr_RS@latin')?.id).toBe('latin')
  expect(recommendedLanguagePack([{ locale: 'zh-Hans' }], 'zh-TW')).toBeUndefined()
})

it('does not turn an unknown system locale into a language recommendation', () => {
  expect(recommendedLanguagePack([{ locale: 'en' }], 'C')).toBeUndefined()
  expect(recommendedLanguagePack([{ locale: 'vi-VN' }], null)).toBeUndefined()
})
