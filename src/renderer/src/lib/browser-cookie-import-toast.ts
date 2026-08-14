import { toast } from 'sonner'
import type { BrowserCookieImportSummary } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

type CookieImportWarning = NonNullable<BrowserCookieImportSummary['warning']>

function formatCookieImportWarning(warning: CookieImportWarning): string {
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
  }
}

function emitGoogleCookieImportWarning(
  summary: BrowserCookieImportSummary,
  executionHostLabel: string
): void {
  if (!summary.googleCookiesSkipped) {
    return
  }
  toast.warning(
    translate(
      'auto.lib.browser.cookie.import.toast.googleCookiesSkipped',
      'Google cookies were not imported. Open a browser in Orca on {{value0}} with this profile, then sign into Google.',
      { value0: executionHostLabel }
    ),
    { duration: 12000 }
  )
}

// Why: a degraded import returns ok:true with a warning, so every call site must route it to a
// warning toast instead of reporting an unqualified success (#9355).
export function emitBrowserCookieImportToast(
  summary: BrowserCookieImportSummary,
  successMessage: string,
  executionHostLabel: string
): void {
  const warning = summary.warning
  if (warning) {
    toast.warning(formatCookieImportWarning(warning))
  } else {
    toast.success(successMessage)
  }
  emitGoogleCookieImportWarning(summary, executionHostLabel)
}
