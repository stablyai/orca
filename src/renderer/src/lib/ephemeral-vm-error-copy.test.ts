import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { ephemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import { ephemeralVmErrorText } from './ephemeral-vm-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('ephemeralVmErrorText', () => {
  it('localizes a coded failure and keeps the interpolated id verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const missing = ephemeralVmFailure('recipeNotFound', { recipeId: 'cloud-{{ref}}' })
    expect(missing.error).toBe('Recipe not found: cloud-{{ref}}')
    expect(ephemeralVmErrorText(missing)).toBe(
      es.ephemeralVm.errors.recipeNotFound.replace('{{recipeId}}', 'cloud-{{ref}}')
    )
  })
})
