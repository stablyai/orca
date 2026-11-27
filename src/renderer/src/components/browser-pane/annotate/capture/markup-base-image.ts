import { withTimeoutResult } from '../../../../../../shared/concurrency/promise-timeout-fallback'

// Capture in the renderer from local webviews or streamed images so local and remote panes share markup delivery.

// Reuse the frozen image as both overlay backdrop and compositor base.
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

export const WEBVIEW_CAPTURE_DEADLINE_MS = 10_000

// The webview's readback until it settles, even after the Draw that started it gave up on it.
const pendingWebviewCaptures = new WeakMap<Electron.WebviewTag, Promise<MarkupBaseImage>>()

/**
 * A Draw that finds an earlier readback still running (one a timed-out Draw abandoned) waits for it
 * and then captures afresh, so a stall fails only the Draws that outlast it and never overlaps two
 * native readbacks. The deadline covers that wait and this readback.
 */
async function captureFromWebview(webview: Electron.WebviewTag): Promise<MarkupBaseImage> {
  let abandoned = false
  const noop = (): void => {}
  // Checking for a readback and submitting one happen in one synchronous step, so two Draws woken
  // together cannot both submit; the one that finds the next readback running waits again.
  const submitWhenFree = (): Promise<MarkupBaseImage> => {
    if (abandoned) {
      return Promise.reject(new Error('markup: capture stalled'))
    }
    const running = pendingWebviewCaptures.get(webview)
    if (running) {
      return running.then(noop, noop).then(submitWhenFree)
    }
    const pending = captureWebviewImage(webview)
    pendingWebviewCaptures.set(webview, pending)
    const release = (): void => {
      if (pendingWebviewCaptures.get(webview) === pending) {
        pendingWebviewCaptures.delete(webview)
      }
    }
    void pending.then(release, release)
    return pending
  }
  const result = await withTimeoutResult(submitWhenFree(), WEBVIEW_CAPTURE_DEADLINE_MS)
  if (!result.ok) {
    // A Draw still waiting for the lane must not submit after its caller saw it fail.
    abandoned = true
    throw new Error('markup: capture failed or stalled')
  }
  return result.value
}

async function captureWebviewImage(webview: Electron.WebviewTag): Promise<MarkupBaseImage> {
  const native = await webview.capturePage()
  if (native.isEmpty()) {
    throw new Error('markup: webview capturePage returned an empty image')
  }
  const size = native.getSize()
  // Flatten transparent capturePage regions onto browser-white so the live guest cannot show through the frozen backdrop.
  const image = await loadImage(native.toDataURL())
  return { dataUrl: flattenToOpaquePng(image, size.width, size.height), ...size }
}

/** A page image main captured right after removing the picker, flattened like a webview capture. */
export async function flattenCapturedPage(capture: {
  dataUrl: string
  width: number
  height: number
}): Promise<MarkupBaseImage> {
  const image = await loadImage(capture.dataUrl)
  return {
    dataUrl: flattenToOpaquePng(image, capture.width, capture.height),
    width: capture.width,
    height: capture.height
  }
}

function captureFromImage(element: HTMLImageElement): MarkupBaseImage {
  const width = element.naturalWidth || element.width
  const height = element.naturalHeight || element.height
  // Reject undecoded/detached frames; drawImage would silently produce a blank PNG.
  if (!element.complete || !element.isConnected || width <= 0 || height <= 0) {
    throw new Error('markup: remote frame image is not ready')
  }
  // Copy the live frame onto an opaque canvas so later frames and transparent regions cannot alter the base.
  return { dataUrl: flattenToOpaquePng(element, width, height), width, height }
}

function flattenToOpaquePng(image: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('markup: 2d context unavailable for base image')
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  return canvas.toDataURL('image/png')
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('markup: failed to decode captured screenshot'))
    image.src = src
  })
}
