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
  it('localizes coded failures while the wire reason stays the legacy English', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    const copyFailed = browserCookieImportFailure('databaseCopyFailed', { browser: 'Arc' })
    expect(copyFailed.reason).toBe('Could not copy Arc cookies database. Try closing Arc first.')
    expect(browserCookieImportFailureText(copyFailed)).toBe(
      es.browser.cookieImport.errors.databaseCopyFailed.replaceAll('{{browser}}', 'Arc')
    )
    const skipped = browserCookieImportFailure('fileNoValidCookies', { count: 1 })
    expect(skipped.reason).toBe(
      'No valid cookies found. 1 entries were skipped due to missing or invalid fields.'
    )
    expect(browserCookieImportFailureText(skipped)).toBe(
      es.browser.cookieImport.errors.fileNoValidCookies_one.replace('{{count}}', '1')
    )
  })

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

  it('shows the host English for uncoded, unknown, or incomplete failures', async () => {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('es')
    expect(browserCookieImportFailureText({ reason: 'Old host text' })).toBe('Old host text')
    expect(browserCookieImportFailureText({ reason: 'Newer', reasonCode: 'futureCode' })).toBe(
      'Newer'
    )
    expect(browserCookieImportFailureText({ reason: 'English', reasonCode: 'noCookies' })).toBe(
      'English'
    )
    expect(browserCookieImportFailureText({ reason: 'English', reasonCode: 'toString' })).toBe(
      'English'
    )
  })
})
