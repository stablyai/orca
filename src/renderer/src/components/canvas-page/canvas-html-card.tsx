import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { CanvasCard } from '@/store/slices/canvas'
import { attachDocPreviewWebview } from '@/components/browser-pane/workspace-doc/doc-preview-webview-attach'
import {
  buildDocPreviewGrantRequest,
  ensureDocPreviewGrant,
  releaseDocPreviewGrant
} from '@/lib/doc-preview-grants'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type PreviewState = 'loading' | 'ready' | 'unavailable'

/**
 * HTML prototype card. Preferred path: the `orca-preview` grant channel inside a `<webview>` —
 * the same one the reader's HTML preview uses, so relative assets and SSH/remote files work.
 * Fallback for purely local files with no runtime/SSH owner: a sandboxed `<iframe srcdoc>`,
 * which is fully self-contained (relative asset paths do not resolve there).
 */
export function CanvasHtmlCard({
  card,
  reloadSignal
}: {
  card: CanvasCard
  reloadSignal: number
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reloadRef = useRef<(() => void) | null>(null)
  const fallbackRef = useRef(false)
  const [state, setState] = useState<PreviewState>('loading')
  const [fallbackHtml, setFallbackHtml] = useState<string | null>(null)
  const previewId = `canvas:${card.id}`

  const readFileIntoFallback = useCallback(
    (isDisposed: () => boolean): void => {
      window.api.fs
        .readFile({ filePath: card.filePath })
        .then((result) => {
          if (isDisposed()) {
            return
          }
          setFallbackHtml(result.content)
          setState('ready')
        })
        .catch(() => {
          if (!isDisposed()) {
            setState('unavailable')
          }
        })
    },
    [card.filePath]
  )

  useEffect(() => {
    let disposed = false
    let detach: (() => void) | undefined
    setState('loading')
    setFallbackHtml(null)
    const request = buildDocPreviewGrantRequest(
      useAppStore.getState(),
      card.worktreeId,
      card.filePath
    )
    fallbackRef.current = !request
    if (!request) {
      // Why: grants need an execution owner (runtime or SSH). A local file with neither still
      // previews as a self-contained document via iframe srcdoc.
      readFileIntoFallback(() => disposed)
      return () => {
        disposed = true
      }
    }
    void ensureDocPreviewGrant(previewId, request)
      .then((handle) => {
        if (disposed || !containerRef.current) {
          return
        }
        const attached = attachDocPreviewWebview({
          previewId,
          container: containerRef.current,
          url: handle.url,
          ariaLabel: translate(
            'auto.components.canvas-page.htmlPreviewAriaLabel',
            'HTML prototype preview'
          ),
          onLoadStarted: () => setState('loading'),
          onLoadStopped: () => setState('ready'),
          onLoadFailed: (event) => {
            if (event.isMainFrame && event.errorCode !== -3) {
              setState('unavailable')
            }
          },
          onNavigated: () => {},
          onTitleUpdated: () => {}
        })
        detach = attached.detach
        reloadRef.current = attached.reload
      })
      .catch(() => {
        if (!disposed) {
          setState('unavailable')
        }
      })
    return () => {
      disposed = true
      reloadRef.current = null
      detach?.()
      // The card owns the grant for its whole lifetime; detach without release would leak it.
      releaseDocPreviewGrant(previewId)
    }
  }, [card.worktreeId, card.filePath, previewId, readFileIntoFallback])

  useEffect(() => {
    let dispose: (() => void) | undefined
    if (reloadSignal > 0) {
      if (fallbackRef.current) {
        // Why: srcdoc has no reload; re-read the file instead. Track the fallback path in a ref —
        // depending on fallbackHtml here re-fires this effect on every set and loops the re-read.
        let disposed = false
        setFallbackHtml(null)
        setState('loading')
        readFileIntoFallback(() => disposed)
        dispose = () => {
          disposed = true
        }
      } else {
        reloadRef.current?.()
      }
    }
    return dispose
  }, [reloadSignal, card.filePath, readFileIntoFallback])

  return (
    <div className="relative h-full overflow-hidden bg-editor-surface">
      <div ref={containerRef} className="absolute inset-0" />
      {fallbackHtml !== null ? (
        <iframe
          title={translate(
            'auto.components.canvas-page.htmlPreviewAriaLabel',
            'HTML prototype preview'
          )}
          sandbox="allow-scripts"
          srcDoc={fallbackHtml}
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      ) : null}
      {state === 'loading' ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {state === 'unavailable' ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-editor-surface px-6 text-center">
          <AlertCircle className="size-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.canvas-page.previewUnavailable', 'Preview unavailable')}
          </p>
        </div>
      ) : null}
    </div>
  )
}
