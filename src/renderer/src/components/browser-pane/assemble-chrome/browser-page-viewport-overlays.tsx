import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { BrowserPageZoomIndicator } from './browser-page-zoom-indicator'
import { BrowserLinkStatusBubble } from './browser-link-status-bubble'
import type {
  BrowserCertificateFailure,
  BrowserLoadError,
  BrowserPage as BrowserPageState
} from '../../../../../shared/browser-workspace-types'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import { BrowserLoadFailureOverlay } from '../navigate/browser-load-failure-overlay'
import { useSshWorkspaceBrowserLoadFailureRoute } from '../use-ssh-workspace-browser-route'
import type { BrowserLoadFailureAutoRetry } from '../navigate/browser-load-failure-auto-retry'
import BrowserFind from './BrowserFind'
import { BrowserNewTabPage } from '../new-tab/BrowserNewTabPage'
import { BrowserGuestAnnotateOverlays } from '../annotate/browser-guest-annotate-overlays'
import type { MarkupModeController } from '../annotate/useMarkupMode'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { retryBrowserTabLoad } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'
import type { useBrowserPageAnnotationSend } from '../annotate/use-browser-page-annotation-send'
import type { useBrowserPageGrabAnnotations } from '../annotate/use-browser-page-grab-annotations'

export function BrowserPageViewportOverlays({
  markup,
  browserZoomIndicatorState,
  browserZoomPercent,
  findOpen,
  setFindOpen,
  webviewRef,
  showFailureOverlay,
  browserTab,
  failureExternalUrl,
  onUpdatePageStateRef,
  retryGuestRecoveryRef,
  navigateToUrl,
  certificateFailure,
  sshRouted,
  autoRetry,
  isBlankTab,
  containerRef,
  markupPortalContainer,
  markupControlsContainer,
  browserOverlayViewport,
  worktreeId,
  grab,
  annotationSend,
  grabAnnotations
}: {
  markup: MarkupModeController
  browserZoomIndicatorState: { ariaHidden: boolean; opacityClassName: string }
  browserZoomPercent: number
  findOpen: boolean
  setFindOpen: Dispatch<SetStateAction<boolean>>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  showFailureOverlay: boolean
  browserTab: BrowserPageState
  failureExternalUrl: string | null
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  navigateToUrl: (url: string) => void
  certificateFailure: BrowserCertificateFailure | null
  sshRouted: boolean
  autoRetry: Omit<BrowserLoadFailureAutoRetry, 'loading'>
  isBlankTab: boolean
  containerRef: RefObject<HTMLDivElement | null>
  markupPortalContainer: HTMLDivElement | null
  markupControlsContainer: HTMLDivElement | null
  browserOverlayViewport: BrowserOverlayViewport
  worktreeId: string
  grab: GrabModeHook
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
}): React.JSX.Element {
  return (
    <>
      <BrowserGuestAnnotateOverlays
        markup={markup}
        grab={grab}
        annotationSend={annotationSend}
        grabAnnotations={grabAnnotations}
        markupPortalContainer={markupPortalContainer}
        markupControlsContainer={markupControlsContainer}
        containerRef={containerRef}
        webviewRef={webviewRef}
        browserOverlayViewport={browserOverlayViewport}
        worktreeId={worktreeId}
        currentUrl={browserTab.url}
      />
      <BrowserPageZoomIndicator state={browserZoomIndicatorState} percent={browserZoomPercent} />
      <BrowserFind isOpen={findOpen} onClose={() => setFindOpen(false)} webviewRef={webviewRef} />
      <BrowserLinkStatusBubble browserPageId={browserTab.id} />
      {showFailureOverlay && browserTab.loadError ? (
        <BrowserPageLoadFailure
          browserTab={browserTab}
          loadError={browserTab.loadError}
          failureExternalUrl={failureExternalUrl}
          certificateFailure={certificateFailure}
          sshRouted={sshRouted}
          worktreeId={worktreeId}
          autoRetry={autoRetry}
          onRetry={() => {
            const webview = webviewRef.current
            if (!webview) {
              return
            }
            onUpdatePageStateRef.current(browserTab.id, { loading: true })
            if (browserTab.loadError?.code === BROWSER_GUEST_RECOVERY_ERROR_CODE) {
              retryGuestRecoveryRef.current()
              return
            }
            retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
          }}
        />
      ) : null}
      {isBlankTab ? <BrowserNewTabPage worktreeId={worktreeId} onOpenUrl={navigateToUrl} /> : null}
    </>
  )
}

/** Mounted only while the page shows a failure, so its SSH-route reads cost nothing otherwise. */
function BrowserPageLoadFailure({
  browserTab,
  loadError,
  failureExternalUrl,
  certificateFailure,
  sshRouted,
  worktreeId,
  autoRetry,
  onRetry
}: {
  browserTab: BrowserPageState
  loadError: BrowserLoadError
  failureExternalUrl: string | null
  certificateFailure: BrowserCertificateFailure | null
  sshRouted: boolean
  worktreeId: string
  autoRetry: Omit<BrowserLoadFailureAutoRetry, 'loading'>
  onRetry: () => void
}): React.JSX.Element {
  const ssh = useSshWorkspaceBrowserLoadFailureRoute(worktreeId)
  return (
    <BrowserLoadFailureOverlay
      loadError={loadError}
      externalUrl={failureExternalUrl}
      onRetry={onRetry}
      onOpenExternal={(url) => void window.api.shell.openUrl(url)}
      certificateFailure={certificateFailure}
      sshRoutedHint={sshRouted}
      onRecheckSshRoute={sshRouted ? ssh.recheck : null}
      route={sshRouted ? ssh.route : { routed: false }}
      autoRetry={{ ...autoRetry, loading: browserTab.loading }}
      expectedBrowserPageId={browserTab.id}
      onProceedCertificate={(challengeId) =>
        window.api.browser.proceedCertificate({ browserPageId: browserTab.id, challengeId })
      }
    />
  )
}
