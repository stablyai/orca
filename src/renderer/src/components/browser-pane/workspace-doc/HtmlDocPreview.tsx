import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import {
  DOC_PREVIEW_PARTITION,
  type DocPreviewFileFailure,
  type DocPreviewFileFailureReason
} from '../../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser-guest-web-preferences'
import { BrowserGuestAnnotateOverlays } from '@/components/browser-pane/annotate/browser-guest-annotate-overlays'
import { useGuestDragPassthrough } from '@/components/browser-pane/host-guest/use-guest-drag-passthrough'
import { isWebviewDragPassthroughActive } from '@/components/browser-pane/host-guest/webview-drag-passthrough'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from '@/lib/doc-preview-grants'
import { selectWorktreeHostDisplayLabel } from '@/lib/execution-host-display-label'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { openDocPreviewExternally, openDocPreviewSource } from './doc-preview-document-actions'
import { buildDocPreviewDocumentIdentity } from './doc-preview-document-identity'
import {
  docPreviewAssetNotice,
  docPreviewDownloadBlockedNotice,
  docPreviewFailureDetail
} from './doc-preview-failure-messages'
import { DocPreviewToolbar } from './doc-preview-toolbar'
import { useDocPreviewWebviewHistory } from './doc-preview-webview-history'
import { useDocPreviewGuestTools } from './use-doc-preview-guest-tools'

type PreviewState = 'loading' | 'ready' | 'unavailable'

function attachDocPreviewWebview({
  container,
  url,
  ariaLabel,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed,
  onNavigated,
  onTitleUpdated
}: {
  container: HTMLDivElement
  url: string
  ariaLabel: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
  onNavigated: () => void
  onTitleUpdated: (event: Electron.PageTitleUpdatedEvent) => void
}): { webview: Electron.WebviewTag; detach: () => void; reload: () => void } {
  const webview = document.createElement('webview') as Electron.WebviewTag
  // Why no allowpopups: the guest's preload intercepts a trusted click on a link before Chromium
  // considers a popup at all, so target="_blank" needs no popup path and every one stays denied.
  webview.setAttribute('partition', DOC_PREVIEW_PARTITION)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('aria-label', ariaLabel)
  // Browsers paint an undeclared page canvas white; the guest is transparent, so without this the
  // editor's dark surface shows through and default black text becomes unreadable.
  webview.style.backgroundColor = '#fff'
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  // Both: a link to a sibling document is a full navigation, a fragment link is an in-page one,
  // and only the pair together tracks what Back can actually return to.
  webview.addEventListener('did-navigate', onNavigated)
  webview.addEventListener('did-navigate-in-page', onNavigated)
  // Why the document names its own tab: a preview is a browser tab, and this is how every other
  // one is named. What the document cannot do is name it the grant it is served over.
  webview.addEventListener('page-title-updated', onTitleUpdated)
  // Why here and not in the enrolling hook: appending is what makes this guest hittable, and the
  // registry's contract is that the path doing so settles it. Dragging the preview's own tab
  // remounts this component mid-drag, and a hook effect lands a turn too late — for the rest of
  // that turn the fresh guest eats the pointer stream and the drag freezes.
  if (isWebviewDragPassthroughActive()) {
    webview.style.pointerEvents = 'none'
  }
  container.appendChild(webview)
  webview.setAttribute('src', url)

  return {
    webview,
    detach: () => {
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      webview.removeEventListener('did-navigate', onNavigated)
      webview.removeEventListener('did-navigate-in-page', onNavigated)
      webview.removeEventListener('page-title-updated', onTitleUpdated)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
    },
    // Why: the protocol handler answers with no-store, so a reload re-reads the workspace disk.
    reload: () => {
      try {
        webview.reload()
      } catch {
        webview.setAttribute('src', url)
      }
    }
  }
}

/** Frames a preview keeps offering focus to a guest that is still attaching. */
const GUEST_FOCUS_FRAMES = 10

export function HtmlDocPreview({
  previewId,
  filePath,
  relativePath,
  worktreeId,
  holdsGuestFocus = false,
  runtimeEnvironmentId = null,
  externalSshTargetId = null
}: {
  previewId: string
  filePath: string
  relativePath: string
  worktreeId: string
  /** Whether this preview is the surface the reader is in, and so may hold the keyboard. */
  holdsGuestFocus?: boolean
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<PreviewState>('loading')
  const [failureReason, setFailureReason] = useState<DocPreviewFileFailureReason | null>(null)
  const [assetFailures, setAssetFailures] = useState<DocPreviewFileFailure[]>([])
  const [downloadBlocked, setDownloadBlocked] = useState(false)
  const [remintCount, setRemintCount] = useState(0)
  const [grantId, setGrantId] = useState<string | null>(null)

  const history = useDocPreviewWebviewHistory(webviewRef)
  const { sync: syncHistory, reset: resetHistory } = history

  const worktreeRoot = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  const hostLabel = useAppStore((store) => selectWorktreeHostDisplayLabel(store, worktreeId))
  const identity = useMemo(
    () => buildDocPreviewDocumentIdentity({ filePath, worktreeRoot, hostLabel }),
    [filePath, hostLabel, worktreeRoot]
  )
  const isUnavailable = state === 'unavailable' || failureReason !== null
  useGuestDragPassthrough(webviewRef, grantId)
  const { grab, markup, annotationSend, grabAnnotations, browserOverlayViewport, elementTools } =
    useDocPreviewGuestTools({
      previewId,
      worktreeId,
      grantId,
      webviewRef,
      containerRef,
      toolsReady: state === 'ready' && !isUnavailable
    })
  // Not `document`: shadowing the global inside a component is how a stray DOM call silently
  // starts reading a plain object.
  const previewDocument = useMemo(
    () => ({ filePath, relativePath, worktreeId, runtimeEnvironmentId, externalSshTargetId }),
    [externalSshTargetId, filePath, relativePath, runtimeEnvironmentId, worktreeId]
  )

  useEffect(() => {
    let disposed = false
    let detach: (() => void) | undefined
    let loadFailed = false
    const onLoadStarted = (): void => {
      loadFailed = false
      setFailureReason(null)
      setAssetFailures([])
      setDownloadBlocked(false)
      setState('loading')
    }
    const onLoadStopped = (): void => {
      // Why sync here too: a navigation's history entry is only committed once loading settles.
      syncHistory()
      if (!loadFailed) {
        setState('ready')
      }
    }
    const onLoadFailed = (event: Electron.DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === -3) {
        return
      }
      loadFailed = true
      setState('unavailable')
    }

    setState('loading')
    setFailureReason(null)
    setAssetFailures([])
    setDownloadBlocked(false)
    setGrantId(null)
    resetHistory()
    const request = buildDocPreviewGrantRequest(useAppStore.getState(), worktreeId, filePath)
    if (!request) {
      setState('unavailable')
      return () => {
        disposed = true
      }
    }
    // Why: an unreadable document answers with a status the guest renders as text, so the reason
    // arrives out-of-band. Subscribe before minting so the entry document's failure cannot be missed.
    let boundGrantId: string | null = null
    const unsubscribeFailure = window.api.docPreview?.onLoadFailure?.((payload) => {
      if (disposed || payload.grantId !== boundGrantId) {
        return
      }
      // Why first: a refused download is the fences answering for the reader, not the document
      // failing to load, so it can never take the page away — and it names no file to compare.
      if (payload.reason === 'download-blocked') {
        setDownloadBlocked(true)
        return
      }
      if (payload.relativePath === request.entryRelativePath) {
        setFailureReason(payload.reason)
        return
      }
      setAssetFailures((current) =>
        current.some((failure) => failure.relativePath === payload.relativePath)
          ? current
          : [...current, payload]
      )
    })
    void ensureDocPreviewGrant(previewId, request)
      .then((handle) => {
        boundGrantId = handle.grantId
        if (disposed || !containerRef.current) {
          return
        }
        const attached = attachDocPreviewWebview({
          container: containerRef.current,
          url: handle.url,
          ariaLabel: translate(
            'auto.components.editor.HtmlDocPreview.previewAriaLabel',
            'HTML preview'
          ),
          onLoadStarted,
          onLoadStopped,
          onLoadFailed,
          onNavigated: syncHistory,
          onTitleUpdated: (event) => {
            useAppStore.getState().updateBrowserPageState(previewId, { title: event.title })
          }
        })
        detach = attached.detach
        reloadRef.current = attached.reload
        webviewRef.current = attached.webview
        // Why only now: main binds this grant to the guest on its first commit, so the tools have
        // nothing to name until the webview exists and is pointed at it.
        setGrantId(handle.grantId)
      })
      .catch(() => {
        if (!disposed) {
          setState('unavailable')
        }
      })

    return () => {
      disposed = true
      reloadRef.current = null
      webviewRef.current = null
      unsubscribeFailure?.()
      detach?.()
    }
  }, [filePath, previewId, remintCount, resetHistory, syncHistory, worktreeId])

  // Why the guest is handed focus rather than left to the press that opens a link: main answers a
  // reported link click only from a focused guest, and a preview has no chrome of its own to pass
  // focus on — a URL page's address bar is what hands it over. Without this the one route out of a
  // preview stays shut until something else happens to focus the document.
  useEffect(() => {
    if (!holdsGuestFocus || state !== 'ready') {
      return
    }
    let frameId = 0
    let attempts = 0
    let claimedOnly = false
    const focusGuest = (): void => {
      const webview = webviewRef.current
      attempts += 1
      // Why a re-offer yields: it is a handoff for focus nothing else wanted, and the reader
      // pressing a tab lands here first. Taking it back would fight them for the keyboard, which
      // is what shut the tab strip while a preview was open.
      if (
        claimedOnly &&
        document.activeElement !== document.body &&
        document.activeElement !== webview
      ) {
        return
      }
      try {
        webview?.focus()
      } catch {
        // Why swallowed: WebViewElement.focus() reads null internals once the guest is destroyed.
        return
      }
      // Why retried: the guest takes focus only once it is attached and laid out, a frame or two
      // after it reports ready.
      if (document.activeElement !== webview && attempts < GUEST_FOCUS_FRAMES) {
        frameId = window.requestAnimationFrame(focusGuest)
      }
    }
    const offerFocus = (yieldToOtherClaims: boolean): void => {
      window.cancelAnimationFrame(frameId)
      attempts = 0
      claimedOnly = yieldToOtherClaims
      frameId = window.requestAnimationFrame(focusGuest)
    }
    // Why assertive: the reader just made this preview their surface, so the handoff is the point.
    offerFocus(false)
    // Why re-offered on the window's own focus: another app taking the front takes focus out of the
    // guest, and coming back puts it on the embedder. Nothing hands it on, so the route out of the
    // preview would stay shut until something remounted it.
    const reofferFocus = (): void => offerFocus(true)
    window.addEventListener('focus', reofferFocus)
    return () => {
      window.removeEventListener('focus', reofferFocus)
      window.cancelAnimationFrame(frameId)
    }
  }, [holdsGuestFocus, previewId, remintCount, state])

  // Why: a grant is pinned to the owner ids resolved when it was minted, so after a pairing or
  // SSH reconnect the old one reads nothing and reloading the guest would just refetch the
  // failure. Drop it and mint against today's ids instead of making the user close the tab.
  const handleHardReload = useCallback(() => {
    releaseDocPreviewGrant(previewId)
    setRemintCount((count) => count + 1)
  }, [previewId])

  const handleReload = useCallback(() => {
    if (failureReason !== null || state === 'unavailable') {
      handleHardReload()
      return
    }
    reloadRef.current?.()
  }, [failureReason, handleHardReload, state])

  // Nothing rendered on an unavailable preview, so a notice strip would be a footnote on a blank page.
  const notices = isUnavailable
    ? []
    : [
        downloadBlocked ? docPreviewDownloadBlockedNotice() : null,
        docPreviewAssetNotice(assetFailures)
      ].filter((notice): notice is string => notice !== null)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
      <DocPreviewToolbar
        identity={identity}
        history={history}
        loading={state === 'loading' && failureReason === null}
        onReload={handleReload}
        onHardReload={handleHardReload}
        onCopyPath={() => void window.api.ui.writeClipboardText(identity.absolutePath)}
        onCopyRelativePath={() => void window.api.ui.writeClipboardText(relativePath)}
        onOpenSource={() => openDocPreviewSource(previewDocument)}
        onOpenExternally={() => openDocPreviewExternally(previewDocument)}
        elementTools={elementTools}
        markupActive={markup.isActive}
        onToggleMarkup={() => (markup.isActive ? markup.cancel() : void markup.start())}
        // Nothing has painted yet on a loading or failed preview, so there is nothing to draw on.
        markupDisabled={isUnavailable || state !== 'ready' || grab.state !== 'idle'}
      />
      {notices.map((notice) => (
        <div
          key={notice}
          className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1 text-xs text-muted-foreground"
          role="status"
          title={notice}
        >
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{notice}</span>
        </div>
      ))}
      <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={containerRef}>
        <BrowserGuestAnnotateOverlays
          markup={markup}
          grab={grab}
          annotationSend={annotationSend}
          grabAnnotations={grabAnnotations}
          containerRef={containerRef}
          webviewRef={webviewRef}
          browserOverlayViewport={browserOverlayViewport}
          worktreeId={worktreeId}
        />
        {state === 'loading' && failureReason === null ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        {isUnavailable ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-editor-surface px-6 text-center">
            <AlertCircle className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {translate(
                'auto.components.editor.HtmlDocPreview.previewUnavailableTitle',
                'Preview unavailable'
              )}
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {docPreviewFailureDetail(failureReason)}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
