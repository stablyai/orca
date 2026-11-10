/**
 * Extension pages (options, tabs.create) rarely declare an icon, and a chrome-extension: icon URL
 * fails the favicon filter and the renderer CSP, so main serves the extension's own icon as a
 * data URL — what Chrome shows on an extension page's tab.
 */
export function isChromeExtensionPageUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith('chrome-extension://')
}

export function applyBrowserExtensionPageFavicon(
  browserPageId: string,
  isStillExtensionPage: () => boolean,
  apply: (faviconDataUrl: string) => void
): void {
  const request = window.api.browser?.extensionsPageIcon
  if (!request) {
    return
  }
  void request({ browserPageId })
    .then((icon) => {
      // Why re-check: the page may have left the extension while main read the icon.
      if (icon && isStillExtensionPage()) {
        apply(icon)
      }
    })
    .catch(() => {})
}
