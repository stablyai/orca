import {
  BrowserClientPageRendererIdentity,
  type BrowserClientPageRendererIdentity as RendererPageIdentity
} from '../../../../shared/browser-client-page-renderer-protocol'
import { readBrowserClientPageAttachedGuestId } from './browser-client-page-retained-elements'
import { browserClientPageRetainedKey } from './browser-client-page-retained-key'
import type { BrowserClientRetainedRendererPage } from './browser-client-page-retained-state'

export function rekeyBrowserClientRetainedPage(
  pages: Map<string, BrowserClientRetainedRendererPage>,
  previousCandidate: RendererPageIdentity,
  nextCandidate: RendererPageIdentity,
  fenceRendererLoss: (page: BrowserClientRetainedRendererPage) => void
): void {
  const previous = BrowserClientPageRendererIdentity.safeParse(previousCandidate)
  const next = BrowserClientPageRendererIdentity.safeParse(nextCandidate)
  if (
    !previous.success ||
    !next.success ||
    previous.data.partition !== next.data.partition ||
    previous.data.browserPageId !== next.data.browserPageId ||
    previous.data.pageHostGeneration === next.data.pageHostGeneration
  ) {
    throw new Error('browser_client_page_renderer_rekey_invalid')
  }
  const previousKey = browserClientPageRetainedKey(previous.data)
  const nextKey = browserClientPageRetainedKey(next.data)
  const page = pages.get(previousKey)
  if (!page || page.status !== 'attached') {
    throw new Error('browser_client_page_renderer_rekey_stale')
  }
  if (pages.has(nextKey)) {
    throw new Error('browser_client_page_renderer_rekey_conflict')
  }
  if (readBrowserClientPageAttachedGuestId(page.webview) !== page.webContentsId) {
    fenceRendererLoss(page)
    throw new Error('browser_client_page_renderer_process_gone')
  }
  pages.delete(previousKey)
  page.key = nextKey
  page.identity = next.data
  pages.set(nextKey, page)
}
