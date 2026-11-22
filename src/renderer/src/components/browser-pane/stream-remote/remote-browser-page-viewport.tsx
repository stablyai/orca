import { useEffect, useMemo, useState } from 'react'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { Globe, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import type {
  BrowserCertificateFailure,
  BrowserCertificateProceedResult,
  BrowserPage as BrowserPageState
} from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import { resolveRemoteFailureExternalUrl } from '../../../../../shared/browser/navigation/browser-url'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import type { BrowserScreencastPointer } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  getRemoteBrowserFrameCursor,
  getRemoteBrowserFrameStyle
} from './remote-browser-frame-style'
import { RemoteBrowserLinkStatusBubble } from './remote-browser-link-status-bubble'
import BrowserFind from '../assemble-chrome/find/BrowserFind'
import type { RemoteBrowserPageFind } from './use-remote-browser-page-find'
import { MarkupOverlay } from '../annotate/MarkupOverlay'
import type { MarkupModeController } from '../annotate/capture/useMarkupMode'
import { BrowserLoadFailureOverlay } from '../navigate/browser-load-failure-overlay'
import { ReopenBrowserPageOnServerButton } from '../navigate/reopen-on-server/ReopenBrowserPageOnServerButton'
import { resolveActiveBrowserLoadFailure } from '../navigate/browser-load-failure-for-url'
import { BrowserNewTabPage } from '../new-tab/BrowserNewTabPage'
import {
  canReconnectRemoteBrowserStream,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'
import {
  BrowserPageFeedbackBadge,
  type BrowserPageFeedbackBadgeHandle
} from '../assemble-chrome/feedback/browser-page-feedback-badge'

export function RemoteBrowserPageViewport({
  remoteViewportRef,
  imageRef,
  feedbackBadgeRef,
  find,
  frameUrl,
  frameMetadata,
  pagePointer,
  busy,
  markup,
  browserTab,
  remoteError,
  streamStatus,
  certificateFailure,
  remotePageHandle,
  activeRuntimeEnvironmentId,
  worktreeId,
  runtimeWorktree,
  runtimeTarget,
  isActive,
  onGoto,
  onNavigateToUrl,
  onReconnect,
  onBeforeProceedCertificate,
  handleRemotePointerDown,
  handleRemotePointerUp,
  handleRemoteContextMenu,
  handleRemoteScreenshotKeyDown,
  handleRemoteScreenshotPaste,
  handleRemotePointerMove,
  annotateOverlays
}: {
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  imageRef: React.RefObject<HTMLImageElement | null>
  feedbackBadgeRef: React.RefObject<BrowserPageFeedbackBadgeHandle | null>
  find: RemoteBrowserPageFind
  frameUrl: string | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  /** The host page's cursor and hovered link; null from hosts that don't report them. */
  pagePointer: BrowserScreencastPointer | null
  busy: boolean
  markup: MarkupModeController
  browserTab: BrowserPageState
  remoteError: string | null
  streamStatus: RemoteBrowserStreamStatus
  certificateFailure: BrowserCertificateFailure | null
  remotePageHandle: RemoteBrowserPageHandle | null
  activeRuntimeEnvironmentId: string
  worktreeId: string
  runtimeWorktree: string
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  isActive: boolean
  onGoto: (url: string) => Promise<void>
  /** The address bar's submit path, which also parks a URL typed before the host page exists. */
  onNavigateToUrl: (url: string) => void
  onReconnect: () => void
  onBeforeProceedCertificate: () => void
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemoteContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
  handleRemoteScreenshotPaste: (event: React.ClipboardEvent<HTMLImageElement>) => void
  /** Takes pointer leaves too, which move the page's pointer off it. */
  handleRemotePointerMove: (event: React.PointerEvent<HTMLImageElement>) => void
  annotateOverlays: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  // Why: runtimes predating browser.certificate-trust.v1 can't honor a proceed request, so hide "Proceed Anyway" until support is advertised.
  const remoteCertificateTrustSupported = useRuntimeEnvironmentCapability(
    certificateFailure?.challengeId ? remotePageHandle?.environmentId : null,
    BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY
  )

  // Transfer viewport focus to the first image, which owns remote key input.
  const hasStreamFrame = frameUrl !== null
  useEffect(() => {
    if (!hasStreamFrame || document.activeElement !== remoteViewportRef.current) {
      return
    }
    imageRef.current?.focus()
  }, [hasStreamFrame, imageRef, remoteViewportRef])

  const remoteFrameStyle = useMemo(() => getRemoteBrowserFrameStyle(frameMetadata), [frameMetadata])
  const pageCursor = pagePointer?.cursor
  const remoteImageStyle = useMemo(
    () => ({ ...remoteFrameStyle, cursor: getRemoteBrowserFrameCursor(pageCursor) }),
    [pageCursor, remoteFrameStyle]
  )
  // Why: hosts clear the error when a re-attempt starts; hold it until this pane's command settles.
  const [standingFailure, setStandingFailure] = useState(browserTab.loadError)
  if (
    browserTab.loadError !== standingFailure &&
    (browserTab.loadError || (!browserTab.loading && !busy))
  ) {
    setStandingFailure(browserTab.loadError)
  }
  const loadError =
    browserTab.loadError ?? resolveActiveBrowserLoadFailure(standingFailure, browserTab.url)
  const remoteFailureUrl = loadError?.validatedUrl ?? browserTab.url
  const remoteFailureExternalUrl = resolveRemoteFailureExternalUrl(remoteFailureUrl)
  const showRemoteFailureOverlay = Boolean(loadError) && !isBlankBrowserUrl(remoteFailureUrl)

  return (
    <div
      ref={remoteViewportRef}
      tabIndex={-1}
      // Why a size container: the frame letterboxes itself in cq units of this pane.
      className="@container-size relative min-h-0 flex-1 overflow-hidden bg-background"
    >
      <BrowserPageFeedbackBadge ref={feedbackBadgeRef} />
      <BrowserFind
        browserPageId={browserTab.id}
        isOpen={find.findOpen}
        onClose={find.closeFind}
        webviewRef={find.findTargetRef}
      />
      {markup.isActive && markup.baseImage ? (
        // Why the frame's own box: markup draws over the letterboxed page, not the whole pane.
        <div className="absolute top-0 left-0" style={remoteFrameStyle}>
          <MarkupOverlay
            baseImage={markup.baseImage}
            busy={markup.state === 'composing'}
            onComplete={(input) => void markup.complete(input)}
            onCancel={markup.cancel}
          />
        </div>
      ) : null}
      {frameUrl ? (
        <img
          data-testid="remote-browser-frame"
          ref={imageRef}
          src={frameUrl}
          alt=""
          tabIndex={0}
          style={remoteImageStyle}
          className="absolute top-0 left-0 max-w-none bg-white outline-none"
          onPointerDown={handleRemotePointerDown}
          onPointerMove={handleRemotePointerMove}
          onPointerLeave={handleRemotePointerMove}
          onPointerUp={handleRemotePointerUp}
          onContextMenu={handleRemoteContextMenu}
          onKeyDown={(event) => {
            find.closeFindOnPageEscape(event)
            handleRemoteScreenshotKeyDown(event)
          }}
          onPaste={handleRemoteScreenshotPaste}
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <div className="flex max-w-sm flex-col items-center gap-2">
            {busy ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="size-5 text-muted-foreground" />
            )}
            <div className="text-sm font-medium text-foreground">
              {busy
                ? t('auto.components.browser.pane.BrowserPane.b313a7275b', 'Opening remote browser')
                : t('auto.components.browser.pane.BrowserPane.572046436a', 'Remote browser')}
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              {t(
                'auto.components.browser.pane.BrowserPane.bbe8f15e83',
                'This pane is rendered from the active runtime server.'
              )}
            </div>
          </div>
        </div>
      )}
      {isBlankBrowserUrl(browserTab.url) ? (
        <BrowserNewTabPage worktreeId={worktreeId} onOpenUrl={onNavigateToUrl} />
      ) : null}
      {annotateOverlays}
      <RemoteBrowserLinkStatusBubble
        browserPageId={browserTab.id}
        targetUrl={pagePointer?.targetUrl ?? ''}
        viewportRef={remoteViewportRef}
      />
      {showRemoteFailureOverlay && loadError ? (
        <BrowserLoadFailureOverlay
          loadError={loadError}
          externalUrl={remoteFailureExternalUrl}
          // Why: reloading the server's error page only refreshes it; re-attempt the URL that failed.
          onRetry={() => onGoto(remoteFailureUrl)}
          autoRetry={{
            active: isActive,
            loading: browserTab.loading
          }}
          onOpenExternal={(url) => void window.api.shell.openUrl(url)}
          certificateFailure={remoteCertificateTrustSupported ? certificateFailure : null}
          expectedBrowserPageId={
            remotePageHandle?.environmentId === activeRuntimeEnvironmentId
              ? remotePageHandle.remotePageId
              : null
          }
          onProceedCertificate={async (challengeId) => {
            const target = runtimeTarget()
            if (
              !target ||
              remotePageHandle?.environmentId !== target.environmentId ||
              remotePageHandle.remotePageId !== certificateFailure?.browserPageId
            ) {
              return { ok: false, reason: 'missing' }
            }
            onBeforeProceedCertificate()
            return callRuntimeRpc<BrowserCertificateProceedResult>(
              target,
              'browser.certificate.proceed',
              {
                worktree: runtimeWorktree,
                page: remotePageHandle.remotePageId,
                challengeId
              },
              { timeoutMs: 15_000, suppressFeatureInteraction: true }
            )
          }}
        />
      ) : null}
      {/* Render the toast for Reconnect even when a host failure supplies no message; the control lives inside it. */}
      {remoteError || canReconnectRemoteBrowserStream(streamStatus) ? (
        <div
          data-testid="remote-browser-stream-error"
          role="status"
          aria-live="polite"
          // Keep Reconnect above the z-20 load-failure sheet so it remains clickable.
          className="absolute bottom-4 left-1/2 z-30 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
          <span>{remoteError}</span>
          {/* Client-placed pages refuse server screencasts; only a new server-placed page can render here. */}
          {remotePageHandle?.placement?.kind === 'client' ? (
            <ReopenBrowserPageOnServerButton
              environmentId={remotePageHandle.environmentId}
              worktreeId={worktreeId}
              reopenUrl={browserTab.url}
              className="h-6 shrink-0 px-2 text-xs"
            />
          ) : null}
          {canReconnectRemoteBrowserStream(streamStatus) ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={onReconnect}
            >
              {t('auto.components.browser.pane.BrowserPane.b71dc3d930', 'Reconnect')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
