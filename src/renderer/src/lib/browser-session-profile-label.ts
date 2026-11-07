import { translate } from '@/i18n/i18n'

/** Display-time label for the built-in default browser session profile. */
export function translateBrowserSessionProfileLabel(
  label: string | null | undefined,
  profileId?: string | null
): string {
  if (profileId === 'default' || label === 'Default' || !label?.trim()) {
    return translate('auto.components.settings.BrowserPane.4399c77caa', 'Default')
  }
  return label
}
