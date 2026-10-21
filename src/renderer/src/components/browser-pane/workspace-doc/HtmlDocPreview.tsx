import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type {
  DocPreviewFileFailure,
  DocPreviewFileFailureReason
} from '../../../../../shared/doc-preview-scheme'
import type { HtmlDocPreviewProps } from './html-doc-preview-props'
import {
  advanceAcrossBrowserPageConversion,
  returnAcrossBrowserPageConversion
} from '@/lib/browser-page-conversion-history'
import { BrowserGuestAnnotateOverlays } from '@/components/browser-pane/annotate/browser-guest-annotate-overlays'
import { attachDocPreviewWebview } from './doc-preview-webview-attach'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant,
  type DocPreviewGrantHandle
} from '@/lib/doc-preview-grants'
import { selectWorktreeHostDisplayLabel } from '@/lib/execution-host-display-label'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { openDocPreviewExternally, openDocPreviewSource } from './doc-preview-document-actions'
import {
  DocPreviewDirectoryAccessBanner,
  useDocPreviewDirectoryAccess
} from './doc-preview-directory-access'
import { buildDocPreviewDocumentIdentity } from './doc-preview-document-identity'
import { docPreviewFailureDetail, docPreviewNotices } from './doc-preview-failure-messages'
import { DocPreviewToolbar } from './doc-preview-toolbar'
import { buildDocPreviewShareControl } from './doc-preview-artifact-share'
import { useDocPreviewWebviewHistory } from './doc-preview-webview-history'
import { useDocPreviewGuestFocus } from './use-doc-preview-guest-focus'
import { useDocPreviewGuestTools } from './use-doc-preview-guest-tools'

type PreviewState = 'loading' | 'ready' | 'unavailable'

const MAX_ASSET_FAILURES = 50

export function HtmlDocPreview({
  previewId,
  filePath,
  relativePath,
  worktreeId,
  holdsGuestFocus = false,
  isActive = true,
  runtimeEnvironmentId = null,
  externalSshTargetId = null,
  convertedFrom = null,
  convertedTo = null
}: HtmlDocPreviewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const [state, setState] = useState<PreviewState>('loading')
  const [failureReason, setFailureReason] = useState<DocPreviewFileFailureReason | null>(null)
  const [assetFailures, setAssetFailures] = useState<DocPreviewFileFailure[]>([])
  const [downloadBlocked, setDownloadBlocked] = useState(false)
  const [remintCount, setRemintCount] = useState(0)
  const [grant, setGrant] = useState<DocPreviewGrantHandle | null>(null)
  const grantId = grant?.grantId ?? null
  const {
    requests: accessRequests,
    busy: accessRequestBusy,
    offer: offerDirectoryAccess,
    reset: resetDirectoryAccess,
    dismiss: dismissDirectoryAccess,
    allow: allowDirectoryAccess
  } = useDocPreviewDirectoryAccess({ grantId, reloadRef })

  const history = useDocPreviewWebviewHistory(webviewRef)
  const { sync: syncHistory, reset: resetHistory } = history
  // Why wrapped rather than a second control: guest history cannot survive a conversion (the
  // guest was replaced), so once it runs out Back returns across the conversion — and Forward
  // re-crosses it — instead of dying.
  const historyWithConversionCrossings = useMemo(
    () =>
      convertedFrom || convertedTo
        ? {
            ...history,
            canGoBack: history.canGoBack || Boolean(convertedFrom),
            canGoForward: history.canGoForward || Boolean(convertedTo),
            goBack: (): void => {
              if (history.canGoBack) {
                history.goBack()
                return
              }
              if (convertedFrom) {
                returnAcrossBrowserPageConversion(previewId, convertedFrom)
              }
            },
            goForward: (): void => {
              if (history.canGoForward) {
                history.goForward()
                return
              }
              if (convertedTo) {
                advanceAcrossBrowserPageConversion(previewId, convertedTo)
              }
            }
          }
        : history,
    [convertedFrom, convertedTo, history, previewId]
  )

  const worktreeRoot = useAppStore((store) => store.getKnownWorktreeById(worktreeId)?.path ?? null)
  const hostLabel = useAppStore((store) => selectWorktreeHostDisplayLabel(store, worktreeId))
  const identity = useMemo(
    () => buildDocPreviewDocumentIdentity({ filePath, worktreeRoot, hostLabel }),
    [filePath, hostLabel, worktreeRoot]
  )
  const isUnavailable = state === 'unavailable' || failureReason !== null
  const {
    grab,
    markup,
    annotationSend,
    grabAnnotations,
    browserOverlayViewport,
    handleAnnotationViewportMessage,
    resetBrowserOverlayViewport,
    elementTools
  } = useDocPreviewGuestTools({
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
      resetBrowserOverlayViewport()
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
    resetDirectoryAccess()
    setDownloadBlocked(false)
    setGrant(null)
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
      if (payload.reason === 'authorization-required') {
        offerDirectoryAccess(payload)
        return
      }
      if (payload.relativePath === request.entryRelativePath) {
        setFailureReason(payload.reason)
        return
      }
      setAssetFailures((current) =>
        current.length >= MAX_ASSET_FAILURES ||
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
          previewId,
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
          onViewportMessage: handleAnnotationViewportMessage,
          onTitleUpdated: (event) => {
            useAppStore.getState().updateBrowserPageState(previewId, { title: event.title })
            // A rename only — the mount already recorded this document's visit.
            useAppStore
              .getState()
              .recordWorkspaceDocVisit(
                { kind: 'workspace-doc', worktreeId, filePath },
                event.title,
                { bump: false }
              )
          }
        })
        detach = attached.detach
        reloadRef.current = attached.reload
        webviewRef.current = attached.webview
        // Why only now: main binds this grant to the guest on its first commit, so the tools have
        // nothing to name until the webview exists and is pointed at it.
        setGrant(handle)
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
  }, [
    filePath,
    offerDirectoryAccess,
    previewId,
    remintCount,
    resetDirectoryAccess,
    handleAnnotationViewportMessage,
    resetBrowserOverlayViewport,
    resetHistory,
    syncHistory,
    worktreeId
  ])

  useEffect(() => {
    // Eviction removes the guest, not the retained pane; only the selected preview restores it.
    if (isActive && webviewRef.current && !webviewRef.current.isConnected) {
      setRemintCount((count) => count + 1)
    }
  }, [isActive, previewId])

  // The dropdown's doc-history source: opening a document is a visit, once per document per mount
  // (a hard reload re-mints the grant but is not a new visit).
  useEffect(() => {
    useAppStore
      .getState()
      .recordWorkspaceDocVisit({ kind: 'workspace-doc', worktreeId, filePath }, null)
  }, [filePath, worktreeId])

  useDocPreviewGuestFocus({
    webviewRef,
    holdsGuestFocus,
    ready: state === 'ready',
    previewId,
    remintCount
  })

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

  const notices = docPreviewNotices(isUnavailable, downloadBlocked, assetFailures)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-editor-surface">
      <DocPreviewToolbar
        identity={identity}
        previewId={previewId}
        worktreeId={worktreeId}
        history={historyWithConversionCrossings}
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
        shareControl={buildDocPreviewShareControl(filePath, grant?.location ?? null)}
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
      {accessRequests.length > 0 && !isUnavailable ? (
        <DocPreviewDirectoryAccessBanner
          requests={accessRequests}
          busy={accessRequestBusy}
          worktreeRoot={worktreeRoot}
          onDismiss={dismissDirectoryAccess}
          onAllow={allowDirectoryAccess}
        />
      ) : null}
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
