import { translate } from '@/i18n/i18n'
import { browserSessionProfileLabel } from '../../../../../shared/browser/profiles/browser-session-profile-label'

/** Display-time label for the built-in default browser session profile. */
export function translateBrowserSessionProfileLabel(
  label: string | null | undefined,
  profileId?: string | null
): string {
  return browserSessionProfileLabel(
    label,
    profileId,
    translate('auto.components.settings.BrowserPane.4399c77caa', 'Default')
  )
}
