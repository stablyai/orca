import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { pdfExportFailure } from '../../../../shared/pdf-export-failure-copy'
import { pdfExportErrorText } from './pdf-export-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('pdfExportErrorText', () => {
  it('translates coded failures and keeps uncoded errors verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const timedOut = pdfExportFailure('timedOut')
    expect(timedOut.error).toBe('Export timed out')
    expect(pdfExportErrorText(timedOut)).toBe(es.editor.pdfExport.errors.timedOut)
    expect(pdfExportErrorText({ error: 'EACCES: permission denied', errorCode: 'future' })).toBe(
      'EACCES: permission denied'
    )
  })
})
