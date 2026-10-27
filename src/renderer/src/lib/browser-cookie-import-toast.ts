import { toast } from 'sonner'
import type { BrowserCookieImportSummary } from '../../../shared/browser-workspace-types'
import { isHandledWireDiscriminant } from '../../../shared/handled-wire-discriminant'
import { translate } from '@/i18n/i18n'

type CookieImportWarning = NonNullable<BrowserCookieImportSummary['warning']>
type CookieImportWarningCode = CookieImportWarning['code']
type UndecryptableReason = Extract<CookieImportWarning, { code: 'cookies-undecryptable' }>['reason']

// RPC can carry newer reason/code values; guard at runtime and use union-keyed Records to make newly known values fail typecheck (#14683).
const HANDLED_WARNING_CODES: Record<CookieImportWarningCode, true> = {
  'restart-fallback-unavailable': true,
  'cookies-undecryptable': true
}

const HANDLED_UNDECRYPTABLE_REASONS: Record<UndecryptableReason, true> = {
  'app-bound-encryption': true,
  'linux-keyring-unavailable': true,
  unknown: true
}

function formatCookieImportWarning(warning: CookieImportWarning): string {
  const code: unknown = warning.code
  if (!isHandledWireDiscriminant(code, HANDLED_WARNING_CODES)) {
    return translate(
      'auto.lib.browser.cookie.import.toast.unrecognizedWarning',
      'The cookie import finished with a warning this version of Orca does not recognize. Update Orca to see the details, then check this profile before relying on its cookies.'
    )
  }
  switch (warning.code) {
    case 'restart-fallback-unavailable':
      return warning.loadedCookies === 0
        ? translate(
            'auto.lib.browser.cookie.import.toast.restartFallbackUnavailableNone',
            'None of the {{value0}} cookies could be loaded, and the restart fallback was unavailable. The previous cookies for this profile were replaced. Try the import again.',
            { value0: warning.failedCookies }
          )
        : translate(
            'auto.lib.browser.cookie.import.toast.restartFallbackUnavailablePartial',
            'Imported {{value0}} of {{value1}} cookies. The rest could not be loaded, and the restart fallback was unavailable. Try the import again.',
            {
              value0: warning.loadedCookies,
              value1: warning.loadedCookies + warning.failedCookies
            }
          )
    case 'cookies-undecryptable': {
      const reason: unknown = warning.reason
      if (!isHandledWireDiscriminant(reason, HANDLED_UNDECRYPTABLE_REASONS)) {
        return translate(
          'auto.lib.browser.cookie.import.toast.undecryptableUnrecognizedReason',
          '{{value0}} cookies could not be decrypted and were skipped for a reason this version of Orca does not recognize. Update Orca to see the details, then try the import again.',
          { value0: warning.failedCookies }
        )
      }
      switch (warning.reason) {
        case 'app-bound-encryption':
          return warning.otherFailedCookies
            ? translate(
                'auto.lib.browser.cookie.import.toast.undecryptableAppBoundMixed',
                "Orca cannot decrypt {{value0}} of this browser's cookies because they use app-bound encryption; {{value1}} more could not be decrypted for another reason. You can import cookies from a file using “From File…”.",
                { value0: warning.failedCookies, value1: warning.otherFailedCookies }
              )
            : translate(
                'auto.lib.browser.cookie.import.toast.undecryptableAppBound',
                "Orca cannot decrypt {{value0}} of this browser's cookies because they use app-bound encryption. You can import cookies from a file using “From File…”.",
                { value0: warning.failedCookies }
              )
        case 'linux-keyring-unavailable':
          if (warning.keyringFailure) {
            const values = {
              browser: warning.keyringFailure.browser,
              count: warning.failedCookies
            }
            let message: string | undefined
            switch (warning.keyringFailure.cause) {
              case 'secret-tool-missing':
                message = translate(
                  'auto.lib.browser.cookie.import.toast.secretToolMissing',
                  "Orca couldn't read {{count}} of {{browser}}'s encrypted cookies because secret-tool isn't installed. Install libsecret-tools (or your distribution's equivalent) and import again.",
                  values
                )
                break
              case 'keyring-locked':
                message = translate(
                  'auto.lib.browser.cookie.import.toast.cookieKeyLocked',
                  "Orca couldn't read {{count}} of {{browser}}'s encrypted cookies because access to the system keyring was locked or denied. Unlock your login keyring, allow access if prompted, and import again.",
                  values
                )
                break
              case 'key-unavailable':
                message = translate(
                  'auto.lib.browser.cookie.import.toast.cookieKeyUnavailable',
                  "Orca couldn't read {{count}} of {{browser}}'s encrypted cookies because the cookie encryption key couldn't be read. Try importing again, import cookies using “From File…”, or sign in directly in Orca.",
                  values
                )
                break
            }
            if (message) {
              return warning.otherFailedCookies
                ? `${message} ${translate(
                    'auto.lib.browser.cookie.import.toast.otherUndecryptableCookies',
                    '{{count}} more cookies could not be decrypted for another reason.',
                    { count: warning.otherFailedCookies }
                  )}`
                : message
            }
          }
          return warning.otherFailedCookies
            ? translate(
                'auto.lib.browser.cookie.import.toast.undecryptableKeyringMixed',
                '{{value0}} cookies could not be decrypted because the system keyring was unavailable; {{value1}} more could not be decrypted for another reason. Unlock your login keyring (or install a Secret Service provider such as gnome-keyring) and import again.',
                { value0: warning.failedCookies, value1: warning.otherFailedCookies }
              )
            : translate(
                'auto.lib.browser.cookie.import.toast.undecryptableKeyring',
                '{{value0}} cookies could not be decrypted because the system keyring was unavailable. Unlock your login keyring (or install a Secret Service provider such as gnome-keyring) and import again.',
                { value0: warning.failedCookies }
              )
        case 'unknown':
          return translate(
            'auto.lib.browser.cookie.import.toast.undecryptableUnknown',
            '{{value0}} cookies could not be decrypted and were skipped. Close the source browser completely and try the import again.',
            { value0: warning.failedCookies }
          )
      }
    }
  }
}

// Match store execution results directly; client means this desktop, remote means the paired runtime.
export type BrowserCookieImportExecution = {
  executionHostLabel: string
  executionMachine: 'client' | 'remote'
  executionRemoteEnvironment: boolean
}

// Remote imports may run on either machine; identify where cookies were read and stored in the toast.
function cookieImportLocationDescription(execution: BrowserCookieImportExecution): string | null {
  if (!execution.executionRemoteEnvironment) {
    return null
  }
  return execution.executionMachine === 'client'
    ? translate(
        'auto.lib.browser.cookie.import.toast.locationClientHosted',
        'Read from this device and stored here for the {{value0}} workspace.',
        { value0: execution.executionHostLabel }
      )
    : translate(
        'auto.lib.browser.cookie.import.toast.locationRemoteHost',
        'Read from browsers on {{value0}} and stored there.',
        { value0: execution.executionHostLabel }
      )
}

function emitGoogleCookieImportWarning(
  summary: BrowserCookieImportSummary,
  execution: BrowserCookieImportExecution
): void {
  if (!summary.googleCookiesSkipped) {
    return
  }
  // Sign-in must use the populated jar: the named workspace remotely, any Orca browser locally; client-hosted pages stay on this desktop.
  const message = !execution.executionRemoteEnvironment
    ? translate(
        'auto.lib.browser.cookie.import.toast.googleCookiesSkippedLocal',
        'Google cookies were not imported. Open a browser in Orca with this profile, then sign into Google.'
      )
    : execution.executionMachine === 'client'
      ? translate(
          'auto.lib.browser.cookie.import.toast.googleCookiesSkippedClientHosted',
          'Google cookies were not imported. Open a browser tab in the {{value0}} workspace with this profile — it opens on this device — then sign into Google.',
          { value0: execution.executionHostLabel }
        )
      : // Use a new key so an older googleCookiesSkipped catalog entry cannot override revised copy.
        translate(
          'auto.lib.browser.cookie.import.toast.googleCookiesSkippedRemoteWorkspace',
          'Google cookies were not imported. Open a browser tab in the {{value0}} workspace with this profile, then sign into Google.',
          { value0: execution.executionHostLabel }
        )
  toast.warning(message, { duration: 12000 })
}

// Skipped partitioned cookies are not downgraded to unpartitioned; warn about loss beyond the success count (STA-4300).
function emitPartitionSkippedImportWarning(summary: BrowserCookieImportSummary): void {
  if (!summary.partitionSkippedCookies) {
    return
  }
  const breakdown = summary.partitionSkipBreakdown
  if (
    breakdown &&
    Number.isSafeInteger(summary.partitionSkippedCookies) &&
    Number.isSafeInteger(breakdown.unreadableCookies) &&
    breakdown.unreadableCookies > 0 &&
    Number.isSafeInteger(breakdown.preservedRelatedCookies) &&
    breakdown.preservedRelatedCookies >= 0 &&
    breakdown.unreadableCookies + breakdown.preservedRelatedCookies ===
      summary.partitionSkippedCookies
  ) {
    toast.warning(
      translate(
        'auto.lib.browser.cookie.import.toast.partitionSkippedBreakdown',
        'Cookies with unreadable site partitions: {{value0}}. Related cookies left unimported to protect existing sessions: {{value1}}. Existing cookies for these sites were left unchanged. Check these sites in this profile before signing in again.',
        { value0: breakdown.unreadableCookies, value1: breakdown.preservedRelatedCookies }
      ),
      { duration: 12000 }
    )
    return
  }
  toast.warning(
    translate(
      'auto.lib.browser.cookie.import.toast.partitionSkipped',
      '{{value0}} cookies were not imported because their site-partition could not be read. Sign in to those sites again in Orca.',
      { value0: summary.partitionSkippedCookies }
    ),
    { duration: 12000 }
  )
}

// Degraded imports still return ok:true; every caller must surface their warning instead of unqualified success (#9355).
export function emitBrowserCookieImportToast(
  summary: BrowserCookieImportSummary,
  successMessage: string,
  execution: BrowserCookieImportExecution
): void {
  const warning = summary.warning
  if (warning) {
    toast.warning(formatCookieImportWarning(warning))
  } else {
    const description = cookieImportLocationDescription(execution)
    if (description) {
      toast.success(successMessage, { description })
    } else {
      toast.success(successMessage)
    }
  }
  emitGoogleCookieImportWarning(summary, execution)
  emitPartitionSkippedImportWarning(summary)
}
