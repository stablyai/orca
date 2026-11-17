import { issueBrowserGuestNavigation } from '../host-guest/browser-guest-metadata-cache'
import { useCallback } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { resolveBrowserAddressBarSubmission } from './browser-address-bar-navigation'
import { routeWorkspaceDocAddressSubmission } from './workspace-doc-address-submission'
import { deferBrowserPageNavigation } from './browser-page-deferred-navigation'
import { getBrowserDisplayTitle, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type { BrowserPageUrlSetter, BrowserTabPageState } from '../describe-page/browser-page-types'

/** Resolve workspace documents before URLs; refuse local file: access and defer navigation until a staged guest attaches. */
export function useClientHostedPageUrlSubmission(params: {
  browserTabId: string
  worktreeId: string
  webviewRef: RefObject<Electron.WebviewTag | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  onSetUrl: BrowserPageUrlSetter
  onUpdatePageState: (pageId: string, updates: Partial<BrowserTabPageState>) => void
  setAddressBarValue: (value: string) => void
}): (value: string) => void {
  const {
    browserTabId,
    worktreeId,
    webviewRef,
    activeLoadFailureRef,
    onSetUrl,
    onUpdatePageState,
    setAddressBarValue
  } = params
  return useCallback(
    (value: string) => {
      const consumedAsWorkspaceDoc = routeWorkspaceDocAddressSubmission({
        worktreeId,
        pageId: browserTabId,
        value,
        onLoadError: (loadError) => onUpdatePageState(browserTabId, { loadError })
      })
      if (consumedAsWorkspaceDoc) {
        return
      }
      const submission = resolveBrowserAddressBarSubmission(value, { allowFileUrls: false })
      if (submission.status === 'invalid') {
        onUpdatePageState(browserTabId, { loadError: submission.loadError })
        return
      }
      const browserModelUrl = redactKagiSessionToken(submission.url)
      activeLoadFailureRef.current = null
      setAddressBarValue(toDisplayUrl(browserModelUrl))
      onSetUrl(browserTabId, browserModelUrl)
      onUpdatePageState(browserTabId, {
        loading: true,
        loadError: null,
        title: getBrowserDisplayTitle(browserModelUrl, browserModelUrl)
      })
      const webview = webviewRef.current
      if (!webview) {
        deferBrowserPageNavigation(browserTabId, submission.url)
        return
      }
      // Why: loadURL rejects on any failed navigation; did-fail-load owns error reporting.
      void issueBrowserGuestNavigation(webview, () => webview.loadURL(submission.url)).catch(
        () => {}
      )
    },
    [
      activeLoadFailureRef,
      browserTabId,
      onUpdatePageState,
      onSetUrl,
      setAddressBarValue,
      webviewRef,
      worktreeId
    ]
  )
}
