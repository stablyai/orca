import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { ephemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import { ephemeralVmCleanupErrorText, ephemeralVmErrorText } from './ephemeral-vm-error-copy'

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

  it('shows the host English for uncoded, unknown, or incomplete failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(ephemeralVmErrorText({ error: 'Old host text' })).toBe('Old host text')
    expect(ephemeralVmErrorText({ error: 'Newer', errorCode: 'futureCode' })).toBe('Newer')
    expect(ephemeralVmErrorText({ error: 'English', errorCode: 'toString' })).toBe('English')
    expect(
      ephemeralVmErrorText({
        error: 'English',
        errorCode: 'destroyExited',
        errorParams: { exitCode: '2' }
      })
    ).toBe('English')
  })

  it('localizes a persisted cleanup error from its stored code', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(
      ephemeralVmCleanupErrorText({
        cleanupLastError: 'Destroy exited with code 3.',
        cleanupLastErrorCode: 'destroyExited',
        cleanupLastErrorParams: { exitCode: 3 }
      })
    ).toBe(es.ephemeralVm.errors.destroyExited.replace('{{exitCode}}', '3'))
    expect(ephemeralVmCleanupErrorText({ cleanupLastError: 'provider said no' })).toBe(
      'provider said no'
    )
  })
})
