import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { PetImportError } from '../../../../shared/pet-import-failure-copy'
import { customPetLabel, petImportFailureText } from './pet-import-failure-text'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('pet import failure text', () => {
  it('localizes a coded failure while main keeps the English error', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const { failure } = new PetImportError('fileTooLarge', { size: '12.5', max: 10 })
    expect(failure.error).toBe('File is too large (12.5 MB). Max is 10 MB.')
    expect(petImportFailureText(failure)).toBe(
      es.pet.importErrors.fileTooLarge.replace('{{size}}', '12.5').replace('{{max}}', '10')
    )
    const parse = new PetImportError('manifestParseFailed', {}, 'Unexpected token }').failure
    expect(petImportFailureText(parse)).toContain('Unexpected token }')
  })

  it('shows main English for unknown codes or missing params', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(petImportFailureText({ ok: false, error: 'Newer', errorCode: 'future' })).toBe('Newer')
    expect(petImportFailureText({ ok: false, error: 'English', errorCode: 'fileTooLarge' })).toBe(
      'English'
    )
  })

  it('translates only the stored default names', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(customPetLabel({ label: 'Custom pet', kind: 'image' })).toBe(es.pet.defaultLabels.image)
    expect(customPetLabel({ label: 'Custom pet' })).toBe(es.pet.defaultLabels.image)
    expect(customPetLabel({ label: 'Pet bundle', kind: 'bundle' })).toBe(
      es.pet.defaultLabels.bundle
    )
    expect(customPetLabel({ label: 'Mochi', kind: 'bundle' })).toBe('Mochi')
  })
})
