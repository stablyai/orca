import type { PdfViewPosition } from '@/lib/scroll-cache'

/** Argument object for pdf.js `PDFViewer.scrollPageIntoView`. */
export type PdfScrollDestination = {
  pageNumber: number
  destArray: unknown[]
  ignoreDestinationZoom: true
  allowNegativeOffset: true
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Normalize an `updateviewarea` payload's `location`. pdf.js does not type
 * EventBus payloads, so this is the validation boundary — a pdf.js upgrade that
 * reshapes the payload degrades to "no restore" rather than throwing.
 */
export function readPdfViewPosition(location: unknown): PdfViewPosition | null {
  if (typeof location !== 'object' || location === null) {
    return null
  }
  const { pageNumber, top, left } = location as Record<string, unknown>
  // Why: scrollPageIntoView itself guards on Number.isInteger and silently
  // logs-and-returns, so a fractional page would fail the restore invisibly.
  if (!isFiniteNumber(pageNumber) || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return null
  }
  if (!isFiniteNumber(top) || !isFiniteNumber(left)) {
    return null
  }
  return { pageNumber, top, left }
}

/**
 * Build the XYZ destination pdf.js uses for its own scale-change position
 * restore (`pdf_viewer.mjs:8843-8853`).
 */
export function buildPdfScrollDestination(position: PdfViewPosition): PdfScrollDestination {
  return {
    pageNumber: position.pageNumber,
    // Why: slot 0 (page ref) is never read on this path; the trailing null zoom
    // pairs with ignoreDestinationZoom so the destination cannot overwrite scale.
    destArray: [null, { name: 'XYZ' }, position.left, position.top, null],
    ignoreDestinationZoom: true,
    // Why: a position in the inter-page gap transforms to a negative offset;
    // clamping it would land at the page top instead, off by the gap height.
    allowNegativeOffset: true
  }
}

/**
 * Clamp a cached page against a document that shrank on disk. Not a safety
 * guard — pdf.js already ignores an out-of-range page — this just lands the
 * reader on the last page instead of nowhere.
 */
export function clampPdfViewPosition(
  position: PdfViewPosition,
  pagesCount: number
): PdfViewPosition | null {
  if (!isFiniteNumber(pagesCount) || pagesCount < 1) {
    return null
  }
  const pageNumber = Math.min(Math.max(position.pageNumber, 1), Math.floor(pagesCount))
  return pageNumber === position.pageNumber ? position : { ...position, pageNumber }
}

export const PDF_POSITION_FLUSH_MS = 150

type TimerHandle = ReturnType<typeof setTimeout>

export type PdfViewPositionRecorder = {
  arm: () => void
  record: (location: unknown) => void
  dispose: () => void
}

/**
 * Owns the record half of PDF scroll preservation: the arm gate and the
 * trailing debounce. Extracted from `PdfViewer` because the effect itself is
 * untestable (node vitest env, and ImageViewer.test mocks useEffect), so every
 * race guard below would otherwise ship uncovered.
 *
 * `dispose` is terminal: afterwards `record` is inert, so a late timer can
 * never resurrect an entry `useClosedEditorTabCleanup` just swept.
 */
export function createPdfViewPositionRecorder({
  key,
  write
}: {
  key: string
  write: (key: string, position: PdfViewPosition) => void
}): PdfViewPositionRecorder {
  let armed = false
  let disposed = false
  let pending: PdfViewPosition | null = null
  let timer: TimerHandle | null = null

  // Why: a strict no-op when nothing was recorded — writing here would clobber a
  // good cached position on a StrictMode double-mount, whose cleanup runs before
  // the reader has scrolled at all.
  const flush = (): void => {
    if (pending) {
      write(key, pending)
    }
  }

  return {
    arm: () => {
      armed = true
    },

    record: (location) => {
      if (!armed || disposed) {
        return
      }
      const position = readPdfViewPosition(location)
      if (!position) {
        return
      }
      pending = position
      if (timer !== null) {
        return
      }
      // Why: the debounced write only refreshes LRU recency — teardown is what
      // actually persists the position — so a pending timer need not restart.
      timer = setTimeout(() => {
        timer = null
        flush()
      }, PDF_POSITION_FLUSH_MS)
    },

    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      flush()
    }
  }
}
