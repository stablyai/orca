import type { RefObject } from 'react'
import { browserPageDocLocationsEqual } from '../../../../../shared/browser/workspaces/browser-page-doc-location'
import type { BrowserPageDocLocation } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { DocPreviewGrantHandle } from '@/lib/browser/documents/doc-preview-grants'
import { useChangedFilePageRefresh } from '@/lib/browser/refresh/use-changed-file-page-refresh'
import {
  sameDocumentUrl,
  type ChangedFileRefreshActionResult
} from '@/lib/browser/refresh/changed-file-page-refresh-driver'

/** A destroyed guest cannot reload; it needs a new grant and guest. */
export function docPreviewGuestAlive(webviewRef: RefObject<Electron.WebviewTag | null>): boolean {
  const webview = webviewRef.current
  if (!webview) {
    return true
  }
  try {
    webview.getWebContentsId()
    return true
  } catch {
    return false
  }
}

/** The doc preview owns its guest, so it satisfies an explicit reopen's refresh through its own reload. */
export function useDocPreviewChangedFileRefresh({
  previewId,
  docLocation,
  webviewRef,
  grantRef,
  guestFailed,
  reload
}: {
  previewId: string
  docLocation: BrowserPageDocLocation
  webviewRef: RefObject<Electron.WebviewTag | null>
  /** The attached guest's grant; its entry URL is the requested document's address. */
  grantRef: RefObject<DocPreviewGrantHandle | null>
  guestFailed: boolean
  reload: () => ChangedFileRefreshActionResult
}): void {
  useChangedFilePageRefresh(previewId, {
    readWebview: () => webviewRef.current,
    pointsAtResource: (resource) =>
      resource.kind === 'document' &&
      browserPageDocLocationsEqual(resource.docLocation, docLocation),
    // Why the entry URL: the guest may show a sibling document while this page still names A.
    isResourceUrl: (url) => grantRef.current !== null && sameDocumentUrl(url, grantRef.current.url),
    guestFailed: () => guestFailed,
    reload,
    navigate: () => {
      const webview = webviewRef.current
      const entryUrl = grantRef.current?.url
      if (!webview || !entryUrl) {
        return 'not-ready'
      }
      try {
        // Same grant and owner: it was minted for this document, so its entry URL is the document.
        void webview.loadURL(entryUrl).catch(() => {})
      } catch {
        return 'not-ready'
      }
      return 'issued'
    }
  })
}
