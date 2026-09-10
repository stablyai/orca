import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react'
import { cn } from '@/lib/utils'
import { Globe } from 'lucide-react'
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
        containerRef={containerRef}
        webviewRef={webviewRef}
        browserOverlayViewport={browserOverlayViewport}
        worktreeId={worktreeId}
      />
      <div
        role="status"
        aria-live="polite"
        aria-hidden={browserZoomIndicatorState.ariaHidden}
        className={cn(
          'pointer-events-none absolute top-3 right-3 z-30 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-xs transition-opacity duration-300 ease-out',
          browserZoomIndicatorState.opacityClassName
        )}
      >
        {browserZoomPercent}%
      </div>
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
      {isBlankTab ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02),transparent_58%)] px-6">
          <div className="flex flex-col items-center px-8 py-8 text-center opacity-70">
            <div className="mb-4 rounded-full border border-border/70 bg-muted/30 p-3">
              <Globe className="size-5 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-foreground/85">
                {translate('auto.components.browser.pane.BrowserPane.366bf5d62c', 'New Tab')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {translate(
                  'auto.components.browser.pane.BrowserPane.f796c774a4',
                  'Type a URL above to start browsing.'
                )}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
