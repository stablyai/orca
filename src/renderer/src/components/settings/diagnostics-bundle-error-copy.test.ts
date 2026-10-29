import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { diagnosticsBundleFailure } from '../../../../shared/diagnostics-bundle-failure-copy'
import { diagnosticsErrorText } from './diagnostics-bundle-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('diagnosticsErrorText', () => {
  it('translates a known refusal through the Electron IPC wrapper', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const refusal = diagnosticsBundleFailure('previewNotOpened')
    const wrapped = new Error(
      `Error invoking remote method 'diagnostics:uploadBundle': Error: ${refusal.message}`
    )
    expect(diagnosticsErrorText(wrapped, 'fallback')).toBe(
      es.settings.diagnostics.errors.previewNotOpened
    )
  })

  it('keeps unknown errors in their unwrapped English text', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const wrapped = new Error(
      "Error invoking remote method 'diagnostics:uploadBundle': Error: upload failed (503)"
    )
    expect(diagnosticsErrorText(wrapped, 'fallback')).toBe('upload failed (503)')
    expect(diagnosticsErrorText(null, 'fallback')).toBe('fallback')
  })
})
