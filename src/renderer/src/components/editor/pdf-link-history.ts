import type { PdfViewPosition } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'

const MAX_PDF_LINK_HISTORY_ENTRIES = 50

export type PdfLinkHistoryState = Readonly<{ canGoBack: boolean; canGoForward: boolean }>

export type PdfLinkHistory = {
  /** The reading position a link is about to leave; clears forward history like a browser. */
  recordJump: (from: PdfViewPosition) => void
  goBack: (current: PdfViewPosition | null) => PdfViewPosition | null
  goForward: (current: PdfViewPosition | null) => PdfViewPosition | null
  getState: () => PdfLinkHistoryState
  subscribe: (listener: () => void) => () => void
}

function samePosition(a: PdfViewPosition | undefined, b: PdfViewPosition): boolean {
  return !!a && a.pageNumber === b.pageNumber && a.top === b.top && a.left === b.left
}

/** Browser-style back/forward over one PDF's in-document link jumps; memory only. */
export function createPdfLinkHistory(maxEntries = MAX_PDF_LINK_HISTORY_ENTRIES): PdfLinkHistory {
  const back: PdfViewPosition[] = []
  const forward: PdfViewPosition[] = []
  const listeners = new Set<() => void>()
  let state: PdfLinkHistoryState = { canGoBack: false, canGoForward: false }

  const publish = (): void => {
    state = { canGoBack: back.length > 0, canGoForward: forward.length > 0 }
    for (const listener of listeners) {
      listener()
    }
  }

  const step = (
    from: PdfViewPosition[],
    to: PdfViewPosition[],
    current: PdfViewPosition | null
  ): PdfViewPosition | null => {
    const target = from.pop()
    if (!target) {
      return null
    }
    if (current) {
      to.push(current)
    }
    publish()
    return target
  }

  return {
    recordJump: (from) => {
      // Why: pdf.js routes some links through two link-service calls for one click.
      if (!samePosition(back.at(-1), from)) {
        back.push(from)
        if (back.length > maxEntries) {
          back.shift()
        }
      }
      forward.length = 0
      publish()
    },
    goBack: (current) => step(back, forward, current),
    goForward: (current) => step(forward, back, current),
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
