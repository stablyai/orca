import { toast } from 'sonner'
import type { BrowserCookieImportSummary } from '../../../shared/browser-workspace-types'
import { isHandledWireDiscriminant } from '../../../shared/handled-wire-discriminant'
import { translate } from '@/i18n/i18n'

type CookieImportWarning = NonNullable<BrowserCookieImportSummary['warning']>
type CookieImportWarningCode = CookieImportWarning['code']
type UndecryptableReason = Extract<CookieImportWarning, { code: 'cookies-undecryptable' }>['reason']

// Why: the summary is cast, not decoded, on the way off the runtime RPC wire, so a newer host can
// send a code/reason this build has never heard of. The Record keys are the union itself, so a new
// member fails typecheck here instead of silently falling out of the switch (#14683 follow-up).
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

// Why: structurally matches BrowserCookieImportExecutionResult so call sites pass the store
// result straight through. 'client' = this desktop ran the import; 'remote' = the paired runtime.
export type BrowserCookieImportExecution = {
  executionHostLabel: string
  executionMachine: 'client' | 'remote'
  executionRemoteEnvironment: boolean
}

// Why: for a remote environment the same Import control silently runs on either machine, so the
// success toast must say where the cookies were read and stored. Local imports need no location.
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
  // Why: the sign-in must happen in the jar the import populated — the named workspace for a
  // remote environment, any Orca browser locally. Client-hosted pages render on this desktop, so
  // say that or the instruction reads as "go to the other machine".
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
      : // Why: not the legacy googleCookiesSkipped key — reworded copy must not inherit the old
        // catalog entry, which i18next prefers over the inline default.
        translate(
          'auto.lib.browser.cookie.import.toast.googleCookiesSkippedRemoteWorkspace',
          'Google cookies were not imported. Open a browser tab in the {{value0}} workspace with this profile, then sign into Google.',
          { value0: execution.executionHostLabel }
        )
  toast.warning(message, { duration: 12000 })
}

// Why (STA-4300): these cookies were skipped rather than downgraded to unpartitioned, so the import
// is lossy in a way the success count alone would hide.
function emitPartitionSkippedImportWarning(summary: BrowserCookieImportSummary): void {
  if (!summary.partitionSkippedCookies) {
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

// Why: a degraded import returns ok:true with a warning, so every call site must route it to a
// warning toast instead of reporting an unqualified success (#9355).
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
