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

/** Validate untyped pdf.js location payloads so incompatible upgrades disable restoration instead of throwing. */
export function readPdfViewPosition(location: unknown): PdfViewPosition | null {
  if (typeof location !== 'object' || location === null) {
    return null
  }
  const { pageNumber, top, left } = location as Record<string, unknown>
  // pdf.js silently refuses fractional pages; reject them at the validation boundary.
  if (!isFiniteNumber(pageNumber) || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return null
  }
  if (!isFiniteNumber(top) || !isFiniteNumber(left)) {
    return null
  }
  return { pageNumber, top, left }
}

/** Use the XYZ destination pdf.js uses for scale-change restoration. */
export function buildPdfScrollDestination(position: PdfViewPosition): PdfScrollDestination {
  return {
    pageNumber: position.pageNumber,
    // The page-ref slot is unused; null zoom plus ignoreDestinationZoom preserves the current scale.
    destArray: [null, { name: 'XYZ' }, position.left, position.top, null],
    ignoreDestinationZoom: true,
    // Preserve negative offsets for inter-page gaps or restoration jumps to the page top.
    allowNegativeOffset: true
  }
}

/** If disk changes shrink the document, restore to its last page rather than nowhere. */
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

/** Record armed positions with bounded LRU refresh; terminal disposal makes late writes inert after the owner detaches. */
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

  // With no recorded scroll, StrictMode cleanup must not overwrite a valid cached position.
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
      // The timer refreshes LRU recency; teardown persists the final position, so later events need not restart it.
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
