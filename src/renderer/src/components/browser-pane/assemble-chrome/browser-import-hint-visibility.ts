export type BrowserImportHintVisibilityInput = {
  persistedUIReady: boolean
  browserImportHintHidden: boolean
}

export function shouldShowBrowserImportHint({
  persistedUIReady,
  browserImportHintHidden
}: BrowserImportHintVisibilityInput): boolean {
  // Keep re-import one click away while the user retains the hint.
  return persistedUIReady && !browserImportHintHidden
}
