export type BrowserImportHintVisibilityInput = {
  persistedUIReady: boolean
  browserImportHintHidden: boolean
}

export function shouldShowBrowserImportHint({
  persistedUIReady,
  browserImportHintHidden
}: BrowserImportHintVisibilityInput): boolean {
  // Why: keep import one click away so users can re-import cookies without
  // hunting through Settings or the toolbar overflow menu.
  return persistedUIReady && !browserImportHintHidden
}
