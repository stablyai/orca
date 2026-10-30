import { useCallback } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { resolveBrowserAddressBarSubmission } from './browser-address-bar-navigation'
import { routeWorkspaceDocAddressSubmission } from './workspace-doc-address-submission'
import { deferBrowserPageNavigation } from './browser-page-deferred-navigation'
import { getBrowserDisplayTitle, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'

/** Resolve workspace documents before URLs; refuse local file: access and defer navigation until a staged guest attaches. */
export function useClientHostedPageUrlSubmission(params: {
  browserTabId: string
  worktreeId: string
  webviewRef: RefObject<Electron.WebviewTag | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  onUpdatePageState: (pageId: string, updates: Partial<BrowserTabPageState>) => void
  setAddressBarValue: (value: string) => void
}): (value: string) => void {
  const {
    browserTabId,
    worktreeId,
    webviewRef,
    activeLoadFailureRef,
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
      const webview = webviewRef.current
      if (!webview) {
        // Park staged navigation for attachment rather than dropping typed input.
        deferBrowserPageNavigation(browserTabId, submission.url)
        setAddressBarValue(toDisplayUrl(redactKagiSessionToken(submission.url)))
        return
      }
      // Never persist Kagi session tokens; match local panes’ optimistic title until the guest reports one.
      const browserModelUrl = redactKagiSessionToken(submission.url)
      activeLoadFailureRef.current = null
      setAddressBarValue(toDisplayUrl(browserModelUrl))
      onUpdatePageState(browserTabId, {
        loading: true,
        loadError: null,
        title: getBrowserDisplayTitle(browserModelUrl, browserModelUrl)
      })
      // Why: loadURL rejects on any failed navigation; did-fail-load owns error reporting.
      void webview.loadURL(submission.url).catch(() => {})
    },
    [
      activeLoadFailureRef,
      browserTabId,
      onUpdatePageState,
      setAddressBarValue,
      webviewRef,
      worktreeId
    ]
  )
}
