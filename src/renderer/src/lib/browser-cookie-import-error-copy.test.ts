import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { browserCookieImportFailure } from '../../../shared/browser-cookie-import-failure-copy'
import { browserCookieImportFailureText } from './browser-cookie-import-error-copy'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

describe('browserCookieImportFailureText', () => {
  it('keeps diagnostic detail verbatim', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const failed = browserCookieImportFailure(
      'importFailedWithLog',
      { browser: 'Chrome', logPath: '/tmp/diag.log' },
      'database is locked {{browser}}'
    )
    expect(failed.reason).toBe(
      'Could not import cookies from Chrome: database is locked {{browser}}. Details were written to /tmp/diag.log.'
    )
    expect(browserCookieImportFailureText(failed)).toContain('database is locked {{browser}}')
  })
})
