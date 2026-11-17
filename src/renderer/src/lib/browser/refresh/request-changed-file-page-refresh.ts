import { useAppStore } from '@/store/index'
import { browserPageNavigationSeq } from '@/components/browser-pane/host-guest/lifecycle/browser-page-main-frame-events'
import type { ChangedFilePageRefreshResource } from './changed-file-page-refresh-intent'

/** Resolves once main has delivered every guest event it sent before this call: main sends guest
 *  events and invoke replies to this renderer on one ordered channel. Any cheap invoke would do; this
 *  read-only one names no guest, so main answers without touching one. */
function guestEventBarrier(pageId: string): Promise<unknown> {
  try {
    return Promise.resolve(
      window.api.browser.getGuestMetadata({ browserPageId: pageId, webContentsId: 0 })
    ).catch(() => null)
  } catch {
    // No bridge (tests, web client): nothing can be queued from main, so the baseline is now.
    return Promise.resolve(null)
  }
}

/** Asks the page's owner to show `resource` fresh, with a baseline separating pre-request navigations. */
export function requestChangedFilePageRefresh(
  pageId: string,
  resource: ChangedFilePageRefreshResource,
  barrier: (pageId: string) => Promise<unknown> = guestEventBarrier
): void {
  const seq = useAppStore.getState().requestChangedFilePageRefresh(pageId, resource)
  void barrier(pageId).then(() => {
    // Every start received so far was sent before main saw this request; later ones were not.
    useAppStore
      .getState()
      .setChangedFilePageRefreshBaseline(pageId, seq, browserPageNavigationSeq(pageId))
  })
}
