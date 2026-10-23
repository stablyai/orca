import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { BrowserPageZoomIndicator } from './browser-page-zoom-indicator'
import { translate } from '@/i18n/i18n'
import { toHttpsRecoveryUrl } from '../../../../../shared/browser-url'
import type {
  BrowserCertificateFailure,
  BrowserPage as BrowserPageState
} from '../../../../../shared/browser-workspace-types'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import { BrowserLoadFailureOverlay } from '../navigate/browser-load-failure-overlay'
import { useSshWorkspaceProbeSkipRecheck } from '../use-ssh-workspace-browser-route'
import BrowserFind from './BrowserFind'
import { BrowserNewTabPage } from '../new-tab/BrowserNewTabPage'
import { BrowserGuestAnnotateOverlays } from '../annotate/browser-guest-annotate-overlays'
import type { MarkupModeController } from '../annotate/useMarkupMode'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { retryBrowserTabLoad, toDisplayUrl } from '../describe-page/browser-page-url-display'
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
  failedNavigationUrl,
  onUpdatePageStateRef,
  retryGuestRecoveryRef,
  navigateToUrl,
  setResourceNotice,
  certificateFailure,
  sshRouted,
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
  failedNavigationUrl: string
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  navigateToUrl: (url: string) => void
  setResourceNotice: Dispatch<SetStateAction<string | null>>
  certificateFailure: BrowserCertificateFailure | null
  sshRouted: boolean
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
  const recheckSshRoute = useSshWorkspaceProbeSkipRecheck(worktreeId)
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
      {showFailureOverlay && browserTab.loadError ? (
        <BrowserLoadFailureOverlay
          loadError={browserTab.loadError}
          externalUrl={failureExternalUrl}
          currentUrl={toDisplayUrl(failedNavigationUrl)}
          httpsRecoveryUrl={toHttpsRecoveryUrl(failedNavigationUrl)}
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
          onTryHttps={navigateToUrl}
          onCopy={(url) => {
            void window.api.ui.writeClipboardText(url)
            setResourceNotice(
              translate('browser.loadFailure.addressCopied', 'Copied the current page address.')
            )
          }}
          onOpenExternal={(url) => void window.api.shell.openUrl(url)}
          certificateFailure={certificateFailure}
          sshRoutedHint={sshRouted}
          onRecheckSshRoute={sshRouted ? recheckSshRoute : null}
          expectedBrowserPageId={browserTab.id}
          onProceedCertificate={(challengeId) =>
            window.api.browser.proceedCertificate({
              browserPageId: browserTab.id,
              challengeId
            })
          }
        />
      ) : null}
      {isBlankTab ? <BrowserNewTabPage worktreeId={worktreeId} onOpenUrl={navigateToUrl} /> : null}
    </>
  )
}
