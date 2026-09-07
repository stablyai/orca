let readControl: (pageId: string) => boolean = () => true

export function installWorkspaceBrowserControlReader(reader: typeof readControl): void {
  readControl = reader
}

export function canControlWorkspaceBrowserPage(pageId: string): boolean {
  return readControl(pageId)
}

export function revokeWorkspaceBrowserInput(): void {
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-browser-page-viewport-id], [data-browser-client-page-id], [data-browser-overlay-tab-id]'
  )) {
    const id =
      element.dataset.browserPageViewportId ??
      element.dataset.browserClientPageId ??
      element.dataset.browserOverlayTabId!
    if (!readControl(id)) {
      element.inert = true
      element.style.pointerEvents = 'none'
    }
  }
}
