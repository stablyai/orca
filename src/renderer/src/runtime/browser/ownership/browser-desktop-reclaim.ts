import { getAllMobileDrivenBrowserPageIds } from './browser-mobile-driver-state'

/** Ends the phone's hold on every browser page it drives, wherever the page is mounted. */
export async function reclaimMobileDrivenBrowserPagesForDesktop(): Promise<void> {
  await Promise.all(
    getAllMobileDrivenBrowserPageIds().map((browserPageId) =>
      // Why: best effort like terminal restore-all; a page left driven keeps its own Take back.
      window.api.runtime.reclaimBrowserForDesktop(browserPageId).catch(() => undefined)
    )
  )
}
