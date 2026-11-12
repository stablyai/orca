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

/** The parts of pdf.js's PDFHistory that PDFLinkService calls. */
export type PdfJsHistoryHooks = {
  pushCurrentPosition: () => void
  push: () => void
  pushPage: () => void
  back: () => void
  forward: () => void
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
  viewer: Pick<InstanceType<typeof PdfJsViewer>, 'update' | 'pagesCount' | 'scrollPageIntoView'>
  linkService: Pick<HistoryAwarePdfLinkService, 'recordIfMoved'> & {
    setHistory: (hooks: PdfJsHistoryHooks) => void
  }
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
  /** The position a jump is about to leave; drops older link-target focus before pdf.js adds this jump's. */
  const beginJump = (): PdfViewPosition | null => {
    cancelPendingLinkTargetFocus()
    onReaderMoved()
    return capturePosition()
  }
  // Why: a self-link, a page step at the last page or an unparsable hash moves nothing and must keep Forward.
  const recordIfLeft = (before: PdfViewPosition | null): void => {
    if (isActive() && before && !samePdfViewPosition(before, capturePosition())) {
      history.recordJump(before)
    }
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

  // pdf.js calls these only after it accepts a destination, and routes the PDF's own
  // GoBack/GoForward actions to back/forward.
  linkService.setHistory({
    pushCurrentPosition: () => {
      // Why: goToDestination resolves its destination asynchronously and can land after teardown.
      if (!isActive()) {
        return
      }
      const before = beginJump()
      // pdf.js scrolls right after this hook returns, in the same task; judge the jump once it has.
      queueMicrotask(() => recordIfLeft(before))
    },
    push: () => {},
    pushPage: () => {},
    back: () => navigate('back'),
    forward: () => navigate('forward')
  })
  linkService.recordIfMoved = (move): void => {
    if (!isActive()) {
      move()
      return
    }
    const before = beginJump()
    move()
    recordIfLeft(before)
  }

  return {
    linkHistory: { navigate, getState: history.getState, subscribe: history.subscribe },
    recordViewArea: (location) => {
      lastPosition = readPdfViewPosition(location) ?? lastPosition
    }
  }
}
