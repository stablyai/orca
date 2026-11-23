import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { emitBrowserCookieImportToast } from './browser-cookie-import-toast'
import { browserCookieImportFailureText } from './browser-cookie-import-error-copy'
import { translateBrowserSessionProfileLabel } from '@/lib/browser/profiles/browser-session-profile-label'
import { BROWSER_FAMILY_LABELS } from '../../../../../shared/browser/browser-family-labels'
import type {
  BrowserSessionProfile,
  BrowserSessionProfileSource
} from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserPageCookieImportRoute } from '@/store/slices/browser/browser-slice-contract'

export type BrowserCookieRefreshSource = {
  browserFamily: string
  profileDirectory: string
  label: string
}

export function browserCookieImportSourceLabel(source: BrowserSessionProfileSource): string {
  const browser = BROWSER_FAMILY_LABELS[source.browserFamily] ?? source.browserFamily
  return source.profileName ? `${browser} (${source.profileName})` : browser
}

/** Null for file imports and for imports saved before the source profile folder was recorded. */
export function browserCookieRefreshSource(
  source: BrowserSessionProfileSource | null | undefined
): BrowserCookieRefreshSource | null {
  if (!source || source.browserFamily === 'manual' || !source.profileDirectory) {
    return null
  }
  return {
    browserFamily: source.browserFamily,
    profileDirectory: source.profileDirectory,
    label: browserCookieImportSourceLabel(source)
  }
}

/** Repeats the last browser import through the same routing as a picked import; a page passes its own jar. */
export async function refreshBrowserProfileCookies(
  profile: Pick<BrowserSessionProfile, 'id' | 'label'>,
  source: BrowserCookieRefreshSource,
  pageRoute: BrowserPageCookieImportRoute | null = null
): Promise<'refreshed' | 'sourceUnavailable' | 'failed'> {
  const result = await useAppStore
    .getState()
    .importCookiesFromBrowser(
      profile.id,
      source.browserFamily,
      source.profileDirectory,
      pageRoute,
      { refreshSavedSource: true }
    )
  if (result.ok) {
    emitBrowserCookieImportToast(
      result.summary,
      translate(
        'browser.cookieImport.refresh.success',
        'Refreshed {{value0}} cookies from {{value1}} into {{value2}}.',
        {
          value0: result.summary.importedCookies,
          value1: source.label,
          value2: translateBrowserSessionProfileLabel(profile.label, profile.id)
        }
      ),
      result
    )
    return 'refreshed'
  }
  if (
    result.reasonCode === 'browserNotFound' ||
    result.reasonCode === 'browserProfileDatabaseMissing' ||
    result.reasonCode === 'savedSourceUnavailable'
  ) {
    toast.error(
      translate(
        'browser.cookieImport.refresh.sourceUnavailable',
        '{{value0}} is no longer available. Choose another source under Import Cookies.',
        { value0: source.label }
      )
    )
    return 'sourceUnavailable'
  }
  toast.error(browserCookieImportFailureText(result))
  return 'failed'
}

/** A page menu's Refresh entry; null when the page's jar is not the one the profile's source describes. */
export function browserPageCookieRefreshAction(
  profile: Pick<BrowserSessionProfile, 'id' | 'label' | 'source'> | undefined,
  pageRoute: BrowserPageCookieImportRoute
): { label: string; onRefresh: () => void } | null {
  // An SSH page reads that host's jar, not the profile's own.
  const source = pageRoute.kind === 'ssh' ? null : browserCookieRefreshSource(profile?.source)
  if (!profile || !source) {
    return null
  }
  return {
    label: source.label,
    onRefresh: () => void refreshBrowserProfileCookies(profile, source, pageRoute)
  }
}
