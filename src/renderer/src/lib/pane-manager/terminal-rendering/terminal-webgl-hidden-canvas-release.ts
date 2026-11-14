// Why: reallocating the backing on reveal costs about one frame, so only terminals left hidden this long pay it.
export const HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS = 30_000

type CanvasRelease = {
  view: Window & typeof globalThis
  resize: ResizeObserver
  mutation: MutationObserver
  timer: number | null
  // A zero-size element yields no initial ResizeObserver entry, so "no box" is the default until one reports.
  hasBox: boolean
  released: boolean
}

const releasesByCanvas = new WeakMap<HTMLCanvasElement, CanvasRelease>()

/**
 * Chromium keeps a display:none WebGL canvas's drawing buffers (on macOS a back buffer plus up to
 * four pooled full-size surfaces), so collapse the backing store once the canvas has stayed without
 * a box. The reveal's ResizeObserver callback runs before that frame paints, and `restore` must
 * reallocate and draw synchronously there: xterm's renderer stays paused until its
 * IntersectionObserver task lands a frame later, and not every engine re-sizes the canvas itself.
 * `canRelease` vetoes panes whose reveal must stay allocation-free.
 */
export function releaseWebglCanvasBackingWhileHidden(
  canvas: HTMLCanvasElement,
  canRelease: () => boolean,
  restore: (devicePixelSize: { width: number; height: number } | null) => void
): void {
  const view = canvas.ownerDocument.defaultView
  if (!view?.ResizeObserver || !view.MutationObserver || releasesByCanvas.has(canvas)) {
    return
  }
  const cancelRelease = (): void => {
    if (release.timer !== null) {
      view.clearTimeout(release.timer)
      release.timer = null
    }
  }
  const scheduleRelease = (): void => {
    if (release.timer !== null || release.hasBox || (canvas.width === 0 && canvas.height === 0)) {
      return
    }
    release.timer = view.setTimeout(() => {
      release.timer = null
      if (release.hasBox) {
        return
      }
      if (!canRelease()) {
        scheduleRelease()
        return
      }
      release.released = true
      canvas.width = 0
      canvas.height = 0
    }, HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS)
  }
  const release: CanvasRelease = {
    view,
    resize: new view.ResizeObserver((entries) => {
      const entry = entries.at(-1)
      const box = entry?.contentRect
      release.hasBox = Boolean(box && (box.width > 0 || box.height > 0))
      if (!release.hasBox) {
        scheduleRelease()
        return
      }
      cancelRelease()
      if (release.released) {
        release.released = false
        const devicePixels = entry?.devicePixelContentBoxSize?.[0]
        restore(
          devicePixels ? { width: devicePixels.inlineSize, height: devicePixels.blockSize } : null
        )
      }
    }),
    // Why: a resize while hidden regrows the backing without a box change, so no resize entry follows.
    mutation: new view.MutationObserver(() => scheduleRelease()),
    timer: null,
    hasBox: false,
    released: false
  }
  release.resize.observe(canvas)
  release.mutation.observe(canvas, { attributeFilter: ['width', 'height'] })
  releasesByCanvas.set(canvas, release)
  // Attached while hidden: a boxless canvas gets no initial resize entry; one with a box cancels this.
  scheduleRelease()
}

export function stopReleasingWebglCanvasBacking(canvas: HTMLCanvasElement): void {
  const release = releasesByCanvas.get(canvas)
  if (!release) {
    return
  }
  if (release.timer !== null) {
    release.view.clearTimeout(release.timer)
  }
  release.resize.disconnect()
  release.mutation.disconnect()
  releasesByCanvas.delete(canvas)
}

export function isWebglCanvasBackingReleased(canvas: HTMLCanvasElement): boolean {
  return releasesByCanvas.get(canvas)?.released === true
}
