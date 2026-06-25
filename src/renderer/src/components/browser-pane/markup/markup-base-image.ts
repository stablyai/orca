// Captures the frozen base screenshot the user draws on. Renderer-only and
// environment-aware: local Electron webviews expose capturePage(); remote panes
// already display the streamed frame as an <img> we can snapshot. Keeping this
// out of the main process means the markup feature works identically for local
// and remote/SSH browser panes.

// A frozen snapshot as a data URL plus its intrinsic pixel size. The overlay
// shows it as an <img> backdrop and reuses that same loaded element as the
// compositor's base layer.
export type MarkupBaseImage = {
  dataUrl: string
  width: number
  height: number
}

export type MarkupCaptureSource =
  | { kind: 'webview'; webview: Electron.WebviewTag }
  | { kind: 'image'; element: HTMLImageElement }

export async function captureMarkupBaseImage(
  source: MarkupCaptureSource
): Promise<MarkupBaseImage> {
  if (source.kind === 'webview') {
    return captureFromWebview(source.webview)
  }
  return captureFromImage(source.element)
}

async function captureFromWebview(webview: Electron.WebviewTag): Promise<MarkupBaseImage> {
  const native = await webview.capturePage()
  if (native.isEmpty()) {
    throw new Error('markup: webview capturePage returned an empty image')
  }
  const size = native.getSize()
  return { dataUrl: native.toDataURL(), width: size.width, height: size.height }
}

function captureFromImage(element: HTMLImageElement): MarkupBaseImage {
  const width = element.naturalWidth || element.width
  const height = element.naturalHeight || element.height
  // Why: drawImage() silently no-ops on an undecoded/detached source, yielding a
  // blank PNG. Fail fast instead so the caller surfaces an error.
  if (!element.complete || !element.isConnected || width <= 0 || height <= 0) {
    throw new Error('markup: remote frame image is not ready')
  }
  // Why: snapshot the live frame into a detached canvas so later screencast
  // frames (or a revoked blob URL) cannot change the base image mid-session.
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('markup: 2d context unavailable for frame snapshot')
  }
  ctx.drawImage(element, 0, 0, width, height)
  return { dataUrl: canvas.toDataURL('image/png'), width, height }
}
