import { getAllMobileDrivenBrowserPageIds } from './browser-mobile-driver-store'

/** Ends the phone's hold on every browser page it drives, wherever the page is mounted. */
export async function reclaimMobileDrivenBrowserPagesForDesktop(): Promise<Set<string>> {
  const reclaimed = new Set<string>()
  await Promise.all(
    getAllMobileDrivenBrowserPageIds().map(async (browserPageId) => {
      // Why: best effort like terminal restore-all; a page left driven keeps its own Take back.
      const result = await window.api.runtime
        .reclaimBrowserForDesktop(browserPageId)
        .catch(() => ({ reclaimed: false }))
      if (result.reclaimed) {
        reclaimed.add(browserPageId)
      }
    })
  )
  return reclaimed
}
