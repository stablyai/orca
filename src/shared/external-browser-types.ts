export type InstalledBrowser = {
  /** macOS bundle id, Windows StartMenuInternet key name, or Linux desktop-file id. */
  id: string
  name: string
}

/** Reserved browser id that forces the OS default browser regardless of settings. */
export const SYSTEM_DEFAULT_BROWSER_ID = 'system-default'

/** The canonical http(s) URL, else null; no base URL, so relative hrefs never resolve. */
export function parseHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function resolveInstalledBrowserName(
  browserId: string | null | undefined,
  installedBrowsers: readonly InstalledBrowser[] | null
): string | null {
  if (!browserId) {
    return null
  }
  return installedBrowsers?.find((browser) => browser.id === browserId)?.name ?? null
}
