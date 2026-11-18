import { translate } from '@/i18n/i18n'

/** Display-time label for the built-in default browser session profile. */
export function translateBrowserSessionProfileLabel(
  label: string | null | undefined,
  profileId?: string | null
): string {
  if (!label?.trim() && profileId && profileId !== 'default') {
    return profileId
  }
  if (profileId === 'default' || !label?.trim() || (profileId == null && label === 'Default')) {
    return translate('auto.components.settings.BrowserPane.4399c77caa', 'Default')
  }
  return label
}
