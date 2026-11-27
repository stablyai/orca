import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'

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
  /** Main removes the page's picker and captures it repainted without it, serialized with every viewer's arm. */
  | { kind: 'clean-page'; browserPageId: string; guestId: number; deadlineMs: number }

/** `signal` aborts when Draw gives up; a clean-page capture then retires its attempt in main. */
export async function captureMarkupBaseImage(
  source: MarkupCaptureSource,
  signal?: AbortSignal
): Promise<MarkupBaseImage> {
  if (source.kind === 'webview') {
    return captureFromWebview(source.webview)
  }
  if (source.kind === 'clean-page') {
    return captureCleanPage(source, signal)
  }
  return captureFromImage(source.element)
}

async function captureFromWebview(webview: Electron.WebviewTag): Promise<MarkupBaseImage> {
  const native = await webview.capturePage()
  if (native.isEmpty()) {
    throw new Error('markup: webview capturePage returned an empty image')
  }
  const size = native.getSize()
  // Flatten transparent capturePage regions onto browser-white so the live guest cannot show through the frozen backdrop.
  const image = await loadImage(native.toDataURL())
  return { dataUrl: flattenToOpaquePng(image, size.width, size.height), ...size }
}

async function captureCleanPage(
  {
    browserPageId,
    guestId,
    deadlineMs
  }: { browserPageId: string; guestId: number; deadlineMs: number },
  signal: AbortSignal | undefined
): Promise<MarkupBaseImage> {
  const attemptId = createNonSecureContextUuid()
  let stopWatching = (): void => {}
  // Rejects the moment Draw gives up or its deadline passes, so no later step publishes for an ended attempt.
  const ended = new Promise<never>((_, reject) => {
    const end = (): void => {
      void window.api.browser.retireCleanCapture({ attemptId })
      reject(new Error('markup: the clean page capture ended'))
    }
    const timer = setTimeout(end, deadlineMs - Date.now())
    signal?.addEventListener('abort', end, { once: true })
    stopWatching = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', end)
    }
  })
  ended.catch(() => {})
  // Timers can't fire during a long synchronous step, so the clock itself is checked at each boundary too.
  const assertLive = (): void => {
    if (signal?.aborted || Date.now() >= deadlineMs) {
      throw new Error('markup: the clean page capture ended')
    }
  }
  try {
    const capture = await Promise.race([
      window.api.browser.captureCleanPage({ browserPageId, attemptId, guestId, deadlineMs }),
      ended
    ])
    if (!capture) {
      throw new Error('markup: the page could not be captured without the picker')
    }
    assertLive()
    const image = await Promise.race([loadImage(capture.dataUrl), ended])
    assertLive()
    const dataUrl = flattenToOpaquePng(image, capture.width, capture.height)
    assertLive()
    return { dataUrl, width: capture.width, height: capture.height }
  } finally {
    stopWatching()
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
