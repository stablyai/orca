import {
  EventBus,
  PDFLinkService,
  type PDFViewer as PdfJsViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PdfViewPosition } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import {
  buildPdfScrollDestination,
  clampPdfViewPosition,
  readPdfViewPosition
} from './pdf-view-position'
import { createPdfLinkHistory, samePdfViewPosition, type PdfLinkHistory } from './pdf-link-history'

export type PdfLinkHistoryDirection = 'back' | 'forward'

export type PdfViewerLinkHistory = Pick<PdfLinkHistory, 'getState' | 'subscribe'> & {
  navigate: (direction: PdfLinkHistoryDirection) => void
}

const PAGE_STEP_NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage'])

/** pdf.js passes `{ signal, internal }` only for its own one-shot listeners, such as link-target focus. */
function readInternalAbortSignal(options: unknown): AbortSignal | null {
  if (
    typeof options !== 'object' ||
    options === null ||
    !('signal' in options) ||
    !('internal' in options) ||
    !options.internal
  ) {
    return null
  }
  return options.signal instanceof AbortSignal ? options.signal : null
}

/**
 * After a link jump pdf.js focuses the target's text layer once it renders, without
 * preventScroll; if the reader has moved on by then, that focus pulls them back to the target.
 */
export function createLinkFocusTrackingEventBus(): {
  eventBus: EventBus
  cancelPendingLinkTargetFocus: () => void
} {
  const pending = new Set<() => void>()
  // Why: pdf.js seals its EventBus, so the subclass keeps its state in this closure.
  class LinkFocusTrackingEventBus extends EventBus {
    override on(
      eventName: string,
      listener: Parameters<EventBus['on']>[1],
      options?: Parameters<EventBus['on']>[2]
    ): void {
      const signal = readInternalAbortSignal(options)
      if (eventName === 'textlayerrendered' && signal) {
        const cancel = (): void => this.off(eventName, listener)
        pending.add(cancel)
        signal.addEventListener('abort', () => pending.delete(cancel), { once: true })
      }
      super.on(eventName, listener, options)
    }
  }
  return {
    eventBus: new LinkFocusTrackingEventBus(),
    cancelPendingLinkTargetFocus: () => {
      for (const cancel of pending) {
        cancel()
      }
      pending.clear()
    }
  }
}

/** Covers the jumps pdf.js makes without its history hook: `#page=`/`#zoom=` hashes and page-step actions. */
export class HistoryAwarePdfLinkService extends PDFLinkService {
  recordIfMoved: (navigate: () => void) => void = (navigate) => navigate()

  override setHash(hash: string): void {
    this.recordIfMoved(() => super.setHash(hash))
  }

  override executeNamedAction(action: string): void {
    if (PAGE_STEP_NAMED_ACTIONS.has(action)) {
      this.recordIfMoved(() => super.executeNamedAction(action))
      return
    }
    super.executeNamedAction(action)
  }
}

/** Browser-style back/forward over a pdf.js viewer's in-document link jumps. */
export function attachPdfLinkHistory({
  viewer,
  linkService,
  cancelPendingLinkTargetFocus,
  isActive,
  onReaderMoved
}: {
  viewer: InstanceType<typeof PdfJsViewer>
  linkService: HistoryAwarePdfLinkService
  cancelPendingLinkTargetFocus: () => void
  isActive: () => boolean
  onReaderMoved: () => void
}): { linkHistory: PdfViewerLinkHistory; recordViewArea: (location: unknown) => void } {
  const history = createPdfLinkHistory()
  let lastPosition: PdfViewPosition | null = null

  // Why: pdf.js reports positions a frame after scrolling; a quick second Back would reuse a stale one.
  const capturePosition = (): PdfViewPosition | null => {
    viewer.update()
    return lastPosition
  }
  const recordDeparture = (from: PdfViewPosition | null): void => {
    // Why: goToDestination resolves its destination asynchronously and can land after teardown.
    if (!isActive()) {
      return
    }
    if (from) {
      history.recordJump(from)
    }
    // pdf.js registers this jump's own target focus after this returns; drop only older ones.
    cancelPendingLinkTargetFocus()
    onReaderMoved()
  }
  const navigate = (direction: PdfLinkHistoryDirection): void => {
    if (!isActive() || viewer.pagesCount < 1) {
      return
    }
    const current = capturePosition()
    const target = direction === 'back' ? history.goBack(current) : history.goForward(current)
    const clamped = target ? clampPdfViewPosition(target, viewer.pagesCount) : null
    if (!clamped) {
      return
    }
    cancelPendingLinkTargetFocus()
    onReaderMoved()
    viewer.scrollPageIntoView(buildPdfScrollDestination(clamped))
  }

  // pdf.js calls these only after it accepts a destination, just before it scrolls,
  // and routes the PDF's own GoBack/GoForward actions to back/forward.
  linkService.setHistory({
    pushCurrentPosition: () => recordDeparture(capturePosition()),
    push: () => {},
    pushPage: () => {},
    back: () => navigate('back'),
    forward: () => navigate('forward')
  })
  linkService.recordIfMoved = (move): void => {
    const before = capturePosition()
    move()
    // Why: a page step at the last page or an unparsable hash moves nothing and must keep Forward.
    if (before && !samePdfViewPosition(before, capturePosition())) {
      recordDeparture(before)
    }
  }

  return {
    linkHistory: { navigate, getState: history.getState, subscribe: history.subscribe },
    recordViewArea: (location) => {
      lastPosition = readPdfViewPosition(location) ?? lastPosition
    }
  }
}
