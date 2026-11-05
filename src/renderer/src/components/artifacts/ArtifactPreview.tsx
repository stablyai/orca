import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/host-guest/webview-registry'
import { translate } from '@/i18n/i18n'

type PreviewState = 'loading' | 'ready' | 'unavailable'
const ARTIFACT_PREVIEW_LOAD_TIMEOUT_MS = 20_000

function scheduleArtifactPreviewTimeout(onTimeout: () => void): () => void {
  const timeout = setTimeout(onTimeout, ARTIFACT_PREVIEW_LOAD_TIMEOUT_MS)
  return () => clearTimeout(timeout)
}

function artifactPreviewUrl(shareUrl: string): string {
  const url = new URL(shareUrl)
  url.searchParams.set('embed', '1')
  return url.toString()
}

function attachArtifactWebview({
  container,
  partition,
  shareUrl,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed
}: {
  container: HTMLDivElement
  partition: string
  shareUrl: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
}): () => void {
  const webview = document.createElement('webview') as Electron.WebviewTag
  webview.setAttribute('partition', partition)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute(
    'aria-label',
    translate('auto.components.artifacts.preview', 'Artifact preview')
  )
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  // Why: forcing white flashes beneath dark artifact pages during navigation.
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  container.appendChild(webview)
  webview.setAttribute('src', artifactPreviewUrl(shareUrl))

  return () => {
    webview.removeEventListener('did-start-loading', onLoadStarted)
    webview.removeEventListener('did-stop-loading', onLoadStopped)
    webview.removeEventListener('did-fail-load', onLoadFailed)
    moveFocusToRendererBeforeWebviewDetach(webview)
    webview.remove()
  }
}

export function ArtifactPreview({ shareUrl }: { shareUrl: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<PreviewState>('loading')

  useEffect(() => {
    let disposed = false
    let detachPreview: (() => void) | undefined
    let cancelLoadTimeout: (() => void) | undefined
    let loadFailed = false
    const clearLoadTimeout = (): void => {
      cancelLoadTimeout?.()
      cancelLoadTimeout = undefined
    }
    const startLoadTimeout = (): void => {
      clearLoadTimeout()
      cancelLoadTimeout = scheduleArtifactPreviewTimeout(() => {
        loadFailed = true
        setState('unavailable')
      })
    }
    const onLoadStarted = (): void => {
      loadFailed = false
      setState('loading')
      startLoadTimeout()
    }
    const onLoadStopped = (): void => {
      clearLoadTimeout()
      if (!loadFailed) {
        setState('ready')
      }
    }
    const onLoadFailed = (event: Electron.DidFailLoadEvent): void => {
      if (!event.isMainFrame || event.errorCode === -3) {
        return
      }
      clearLoadTimeout()
      loadFailed = true
      setState('unavailable')
    }

    setState('loading')
    startLoadTimeout()
    void window.api.browser
      .sessionResolvePartition({ profileId: null })
      .then((partition) => {
        if (disposed || !partition || !containerRef.current) {
          if (!disposed) {
            clearLoadTimeout()
            setState('unavailable')
          }
          return
        }

        detachPreview = attachArtifactWebview({
          container: containerRef.current,
          partition,
          shareUrl,
          onLoadStarted,
          onLoadStopped,
          onLoadFailed
        })
        startLoadTimeout()
      })
      .catch(() => {
        if (!disposed) {
          clearLoadTimeout()
          setState('unavailable')
        }
      })

    return () => {
      disposed = true
      clearLoadTimeout()
      detachPreview?.()
    }
  }, [shareUrl])

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-editor-surface"
      ref={containerRef}
    >
      {state === 'loading' ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-editor-surface">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}
      {state === 'unavailable' ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-editor-surface px-6 text-center">
          <AlertCircle className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">
            {translate('auto.components.artifacts.previewUnavailable', 'Preview unavailable')}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {translate(
              'auto.components.artifacts.previewUnavailableDescription',
              'Open this artifact in your browser to view it.'
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
