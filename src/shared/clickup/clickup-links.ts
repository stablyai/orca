/** Where a ClickUp user generates the personal API token Orca connects with. */
export const CLICKUP_APPS_SETTINGS_URL = 'https://app.clickup.com/settings/apps'

/** A ClickUp item's link comes from the host's reply, so only an https URL may be handed to the OS. */
export function isClickUpOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
