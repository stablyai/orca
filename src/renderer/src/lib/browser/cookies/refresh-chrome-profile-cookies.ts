import { toast } from 'sonner'
import type { BrowserSessionProfile } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { browserCookieImportFailureText } from './browser-cookie-import-error-copy'
import { translateBrowserSessionProfileLabel } from '../profiles/browser-session-profile-label'
import { emitBrowserCookieImportToast } from './browser-cookie-import-toast'

export async function refreshChromeProfileCookies(
  profile: BrowserSessionProfile,
  hostId: ExecutionHostId
): Promise<void> {
  const source = profile.source
  if (!source?.chromeProfile) {
    return
  }
  const result = await useAppStore.getState().importCookiesFromBrowser(profile.id, {
    refreshSourceId: source.chromeProfile.id,
    hostId
  })
  if (!result.ok) {
    toast.error(browserCookieImportFailureText(result))
    return
  }
  emitBrowserCookieImportToast(
    result.summary,
    translate('browser.cookieImport.refreshedChrome', 'Refreshed {{profile}} from Chrome.', {
      profile: translateBrowserSessionProfileLabel(profile.label, profile.id)
    }),
    result
  )
}
