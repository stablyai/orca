import { useMemo } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import type {
  BrowserCertificateFailure,
  BrowserCertificateProceedResult,
  BrowserPage as BrowserPageState
} from '../../../../../shared/browser-workspace-types'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser'
import {
  resolveRemoteFailureExternalUrl,
  toHttpsRecoveryUrl
} from '../../../../../shared/browser-url'
import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser-screencast-protocol'
import { getRemoteBrowserFrameStyle } from './remote-browser-frame-style'
import { MarkupOverlay } from '../annotate/MarkupOverlay'
import type { MarkupModeController } from '../annotate/useMarkupMode'
import { BrowserLoadFailureOverlay } from '../navigate/browser-load-failure-overlay'
import { ReopenBrowserPageOnServerButton } from '../ReopenBrowserPageOnServerButton'
import { toDisplayUrl } from '../describe-page/browser-page-url-display'
import {
  canReconnectRemoteBrowserStream,
  type RemoteBrowserStreamStatus
} from './remote-browser-stream-status'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'

export function RemoteBrowserPageViewport({
  remoteViewportRef,
  imageRef,
  frameUrl,
  frameMetadata,
  busy,
  markup,
  browserTab,
  remoteError,
  streamStatus,
  remoteCertificateTrustSupported,
  certificateFailure,
  remotePageHandle,
  activeRuntimeEnvironmentId,
  worktreeId,
  runtimeWorktree,
  runtimeTarget,
  onReload,
  onGoto,
  onReconnect,
  handleRemotePointerDown,
  handleRemotePointerUp,
  handleRemoteContextMenu,
  handleRemoteScreenshotKeyDown
}: {
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  imageRef: React.RefObject<HTMLImageElement | null>
  frameUrl: string | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  busy: boolean
  markup: MarkupModeController
  browserTab: BrowserPageState
  remoteError: string | null
  streamStatus: RemoteBrowserStreamStatus
  remoteCertificateTrustSupported: boolean
  certificateFailure: BrowserCertificateFailure | null
  remotePageHandle: RemoteBrowserPageHandle | null
  activeRuntimeEnvironmentId: string
  worktreeId: string
  runtimeWorktree: string
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  onReload: () => void
  onGoto: (url: string) => void
  onReconnect: () => void
  handleRemotePointerDown: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemotePointerUp: (event: React.PointerEvent<HTMLImageElement>) => void
  handleRemoteContextMenu: (event: React.MouseEvent<HTMLImageElement>) => void
  handleRemoteScreenshotKeyDown: (event: React.KeyboardEvent<HTMLImageElement>) => void
}): React.JSX.Element {
  const remoteFrameStyle = useMemo(() => getRemoteBrowserFrameStyle(frameMetadata), [frameMetadata])
  const remoteFailureUrl = browserTab.loadError?.validatedUrl ?? browserTab.url
  const remoteFailureExternalUrl = resolveRemoteFailureExternalUrl(remoteFailureUrl)
  const showRemoteFailureOverlay =
    Boolean(browserTab.loadError) &&
    remoteFailureUrl !== 'about:blank' &&
    remoteFailureUrl !== ORCA_BROWSER_BLANK_URL

  return (
    <div
      ref={remoteViewportRef}
      tabIndex={-1}
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
    >
      {markup.isActive && markup.baseImage ? (
        <MarkupOverlay
          baseImage={markup.baseImage}
          busy={markup.state === 'composing'}
          onComplete={(input) => void markup.complete(input)}
          onCancel={markup.cancel}
        />
      ) : null}
      {frameUrl ? (
        <img
          data-testid="remote-browser-frame"
          ref={imageRef}
          src={frameUrl}
          alt=""
          tabIndex={0}
          style={remoteFrameStyle}
          className="absolute top-0 left-0 max-w-none cursor-default bg-white outline-none"
          onPointerDown={handleRemotePointerDown}
          onPointerUp={handleRemotePointerUp}
          onContextMenu={handleRemoteContextMenu}
          onKeyDown={handleRemoteScreenshotKeyDown}
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
                ? translate(
                    'auto.components.browser.pane.BrowserPane.b313a7275b',
                    'Opening remote browser'
                  )
                : translate(
                    'auto.components.browser.pane.BrowserPane.572046436a',
                    'Remote browser'
                  )}
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              {translate(
                'auto.components.browser.pane.BrowserPane.bbe8f15e83',
                'This pane is rendered from the active runtime server.'
              )}
            </div>
          </div>
        </div>
      )}
      {showRemoteFailureOverlay && browserTab.loadError ? (
        <BrowserLoadFailureOverlay
          loadError={browserTab.loadError}
          externalUrl={remoteFailureExternalUrl}
          currentUrl={toDisplayUrl(remoteFailureUrl)}
          httpsRecoveryUrl={toHttpsRecoveryUrl(remoteFailureUrl)}
          onRetry={onReload}
          onTryHttps={onGoto}
          onCopy={(url) => void window.api.ui.writeClipboardText(url)}
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
      {/* Why the reconnect control also opens this toast: the control renders inside it, so
          gating the toast on the message alone made an empty message ('' from a host that failed
          with no text) swallow the user's only way back — the original stranding bug, reachable
          through three sites that forward host-supplied text into `stopped`. */}
      {remoteError || canReconnectRemoteBrowserStream(streamStatus) ? (
        <div
          data-testid="remote-browser-stream-error"
          role="status"
          aria-live="polite"
          // Why z-30: the load-failure overlay is a z-20 full-pane sheet, so without this the
          // Reconnect control renders beneath it and silently swallows every click — the user's
          // only way back, present but unusable, whenever the page also failed to load.
          className="absolute bottom-4 left-1/2 z-30 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
          <span>{remoteError}</span>
          {/* Why: the runtime refuses server screencast for a client-placed page, so reconnecting
              can never render it here. A new server-placed page is the only way through. */}
          {remotePageHandle?.placement?.kind === 'client' ? (
            <ReopenBrowserPageOnServerButton
              environmentId={remotePageHandle.environmentId}
              worktreeId={worktreeId}
              lastCommittedUrl={browserTab.url}
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
              {translate('auto.components.browser.pane.BrowserPane.b71dc3d930', 'Reconnect')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
