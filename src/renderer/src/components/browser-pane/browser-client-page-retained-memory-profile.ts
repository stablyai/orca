import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'

export type BrowserClientPageRendererMemoryProfile = {
  retainedPageCount: number
  attachingPageCount: number
  attachedPageCount: number
  retiringPageCount: number
  partitionCount: number
}

export function snapshotBrowserClientPageRendererMemoryProfile(
  pages: Map<string, RetainedPage>,
  partitionCount: number
): BrowserClientPageRendererMemoryProfile {
  let attachingPageCount = 0
  let attachedPageCount = 0
  let retiringPageCount = 0
  for (const page of pages.values()) {
    if (page.status === 'attaching') {
      attachingPageCount += 1
    } else if (page.status === 'attached') {
      attachedPageCount += 1
    } else {
      retiringPageCount += 1
    }
  }
  return {
    retainedPageCount: pages.size,
    attachingPageCount,
    attachedPageCount,
    retiringPageCount,
    partitionCount
  }
}
