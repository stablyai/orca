import { translate } from '@/i18n/i18n'
import {
  BROWSER_COOKIE_IMPORT_FAILURE_COPY as EN,
  type BrowserCookieImportFailure,
  type BrowserCookieImportFailureCode
} from '../../../shared/browser-cookie-import-failure-copy'

type Values = {
  text: (name: string) => string | null
  count: (name: string) => number | null
}

// null = required values missing; caller shows the host's English `reason`.
const COPY: Record<BrowserCookieImportFailureCode, (values: Values) => string | null> = {
  notAuthorized: () => translate('browser.cookieImport.errors.notAuthorized', EN.notAuthorized),
  profileNotFound: () =>
    translate('browser.cookieImport.errors.profileNotFound', EN.profileNotFound),
  invalidBrowserProfile: () =>
    translate('browser.cookieImport.errors.invalidBrowserProfile', EN.invalidBrowserProfile),
  browserNotFound: () =>
    translate('browser.cookieImport.errors.browserNotFound', EN.browserNotFound),
  browserProfileDatabaseMissing: ({ text }) => {
    const profile = text('profile')
    return profile === null
      ? null
      : translate(
          'browser.cookieImport.errors.browserProfileDatabaseMissing',
          EN.browserProfileDatabaseMissing,
          { profile }
        )
  },
  fileUnreadable: () => translate('browser.cookieImport.errors.fileUnreadable', EN.fileUnreadable),
  fileInvalidJson: () =>
    translate('browser.cookieImport.errors.fileInvalidJson', EN.fileInvalidJson),
  fileNotArray: () => translate('browser.cookieImport.errors.fileNotArray', EN.fileNotArray),
  fileEmpty: () => translate('browser.cookieImport.errors.fileEmpty', EN.fileEmpty),
  fileNoValidCookies: ({ count: readCount }) => {
    const count = readCount('count')
    return count === null
      ? null
      : translate('browser.cookieImport.errors.fileNoValidCookies', EN.fileNoValidCookies.other, {
          count,
          defaultValue_one: EN.fileNoValidCookies.one
        })
  },
  databaseNotFound: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.databaseNotFound', EN.databaseNotFound, { browser })
  },
  databaseCopyFailed: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.databaseCopyFailed', EN.databaseCopyFailed, {
          browser
        })
  },
  noCookies: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.noCookies', EN.noCookies, { browser })
  },
  noValidCookies: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.noValidCookies', EN.noValidCookies, { browser })
  },
  allCookiesExpired: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.allCookiesExpired', EN.allCookiesExpired, {
          browser
        })
  },
  encryptionKeyDenied: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.encryptionKeyDenied', EN.encryptionKeyDenied, {
          browser
        })
  },
  readFailed: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.readFailed', EN.readFailed, { browser })
  },
  importFailed: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.importFailed', EN.importFailed, { browser })
  },
  importFailedTryClosing: ({ text }) => {
    const browser = text('browser')
    return browser === null
      ? null
      : translate('browser.cookieImport.errors.importFailedTryClosing', EN.importFailedTryClosing, {
          browser
        })
  },
  importFailedWithLog: ({ text }) => {
    const browser = text('browser')
    const detail = text('detail')
    const logPath = text('logPath')
    return browser === null || detail === null || logPath === null
      ? null
      : translate('browser.cookieImport.errors.importFailedWithLog', EN.importFailedWithLog, {
          browser,
          detail,
          logPath
        })
  },
  safariFullDiskAccess: () =>
    translate('browser.cookieImport.errors.safariFullDiskAccess', EN.safariFullDiskAccess),
  connectionEnded: () =>
    translate('browser.cookieImport.errors.connectionEnded', EN.connectionEnded),
  serverRepaired: () => translate('browser.cookieImport.errors.serverRepaired', EN.serverRepaired)
}

function isBrowserCookieImportFailureCode(code: unknown): code is BrowserCookieImportFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

/** Unknown codes (newer host) and uncoded failures (older host) show the host's English reason. */
export function browserCookieImportFailureText(
  failure: Pick<
    BrowserCookieImportFailure,
    'reason' | 'reasonCode' | 'reasonParams' | 'reasonDetail'
  >
): string {
  if (!isBrowserCookieImportFailureCode(failure.reasonCode)) {
    return failure.reason
  }
  const params = failure.reasonParams ?? {}
  const read = (name: string): unknown => (Object.hasOwn(params, name) ? params[name] : undefined)
  const values: Values = {
    text: (name) => {
      const value = name === 'detail' ? failure.reasonDetail : read(name)
      return typeof value === 'string' ? value : null
    },
    count: (name) => {
      const value = read(name)
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
  }
  return COPY[failure.reasonCode](values) ?? failure.reason
}
