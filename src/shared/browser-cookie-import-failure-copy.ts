// One English table for cookie import refusals: main builds the wire `reason`, the renderer translates by code.
export const BROWSER_COOKIE_IMPORT_FAILURE_COPY = {
  notAuthorized: 'Not authorized',
  profileNotFound: 'Session profile not found.',
  invalidBrowserProfile: 'Invalid browser profile name.',
  browserNotFound: 'Browser not found on this system.',
  browserProfileDatabaseMissing: 'No cookies database found for profile "{{profile}}".',
  fileUnreadable: 'Could not read the selected file.',
  fileInvalidJson: 'File is not valid JSON.',
  fileNotArray: 'Expected a JSON array of cookie objects.',
  fileEmpty: 'Cookie file is empty.',
  fileNoValidCookies: {
    one: 'No valid cookies found. {{count}} entry was skipped due to missing or invalid fields.',
    other:
      'No valid cookies found. {{count}} entries were skipped due to missing or invalid fields.'
  },
  databaseNotFound: '{{browser}} cookies database not found.',
  databaseCopyFailed: 'Could not copy {{browser}} cookies database. Try closing {{browser}} first.',
  noCookies: 'No cookies found in {{browser}}.',
  noValidCookies: 'No valid cookies found in {{browser}}.',
  allCookiesExpired: 'All {{browser}} cookies are expired.',
  encryptionKeyDenied:
    'Could not access {{browser}} encryption key. The OS may have denied access.',
  readFailed: 'Could not read {{browser}} cookies.',
  importFailed: 'Could not import cookies from {{browser}}.',
  importFailedTryClosing:
    'Could not import cookies from {{browser}}. Try closing {{browser}} first.',
  importFailedWithLog:
    'Could not import cookies from {{browser}}: {{detail}}. Details were written to {{logPath}}.',
  safariFullDiskAccess:
    'macOS denied access to Safari cookies. Grant Full Disk Access to Orca in System Settings → Privacy & Security → Full Disk Access.',
  connectionEnded:
    'The connection to this server ended during the import. Reconnect and try again.',
  serverRepaired: 'This server was re-paired during the import. Try again.'
} as const

export type BrowserCookieImportFailureCode = keyof typeof BROWSER_COOKIE_IMPORT_FAILURE_COPY

export type BrowserCookieImportFailureParams = Record<string, string | number>

/** Wire shape: `reason` stays English for older clients; `reasonDetail` is verbatim diagnostic text. */
export type BrowserCookieImportFailure = {
  ok: false
  reason: string
  reasonCode?: string
  reasonParams?: BrowserCookieImportFailureParams
  reasonDetail?: string
}

function englishTemplate(code: BrowserCookieImportFailureCode): string {
  const entry = BROWSER_COOKIE_IMPORT_FAILURE_COPY[code]
  // Wire English predates the singular form; keep it byte-identical for older clients.
  return typeof entry === 'string' ? entry : entry.other
}

export function browserCookieImportFailure(
  code: BrowserCookieImportFailureCode,
  params: BrowserCookieImportFailureParams = {},
  detail?: string
): BrowserCookieImportFailure {
  const values: BrowserCookieImportFailureParams =
    detail === undefined ? params : { ...params, detail }
  // One pass, so a value containing "{{detail}}" stays verbatim.
  const reason = englishTemplate(code).replace(/\{\{(\w+)\}\}/g, (slot, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : slot
  )
  return {
    ok: false,
    reason,
    reasonCode: code,
    ...(Object.keys(params).length > 0 ? { reasonParams: params } : {}),
    ...(detail !== undefined ? { reasonDetail: detail } : {})
  }
}
