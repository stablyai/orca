// Shared layout/observer stubs for the NativeChatMessageList windowing suites.
// happy-dom has no layout and never fires ResizeObserver, so windowing only
// engages against the stubs below.
import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  estimateNativeChatRowHeight,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

export const VIEWPORT_PX = 600
export const TRANSCRIPT_LENGTH = 200

/** Everything the document holds below the last row: the transcript column's
 *  trailing chrome and the scroll root's bottom padding. Non-zero on purpose —
 *  the document's bottom sits past the window's last row, which is exactly where
 *  a pin computed from the virtualizer's totals and one computed from the
 *  document disagree. */
export const BELOW_TRANSCRIPT_PX = 24

/** Everything the document holds above the spacer: the scroll root's top gutter,
 *  and the "load earlier" block whenever there is older history to page in. This
 *  is the virtualizer's `scrollMargin`, and it is the larger half of the gap
 *  between the document's end and the end the virtualizer computes. */

/** Heights the stubbed layout reports per row index, when a case wants a row to
 *  measure as something other than its estimate. Empty means "every row at its
 *  estimate", which is what every non-growth case wants. */

/** Layout knobs the stubs read and a case writes. One shared cell so the test
 *  module and the stubs below see the same values. */
export const layout: {
  belowTranscriptPx: number
  aboveTranscriptPx: number
  measuredRowHeights: readonly number[]
} = { belowTranscriptPx: BELOW_TRANSCRIPT_PX, aboveTranscriptPx: 0, measuredRowHeights: [] }

export function marker(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `marker-${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

export const ROW_PX = estimateNativeChatRowHeight(nativeChatRowContentMetrics(marker(0)), {
  hasReceipt: false,
  hasStatus: false,
  hasTurnDiff: false
})
export const ROW_PITCH_PX = ROW_PX + NATIVE_CHAT_ROW_GAP_PX

/** Replace a layout property on every element, and hand back the undo. */
export function overrideLayoutProperty(name: string, descriptor: PropertyDescriptor): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, name, original)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
}

/** The spacer's reserved height, which is the transcript's whole rendered height:
 *  windowed rows are absolutely positioned inside it, so a row growing in place
 *  reaches the document only through the height the window reserves for it. */
export function reservedTranscriptHeight(root: ParentNode): number {
  const spacer = root.querySelector<HTMLElement>('[data-native-chat-window]')
  return spacer ? Number.parseFloat(spacer.style.height) || 0 : 0
}

// The virtualizer measures with `offsetHeight` — not `clientHeight`, not a
// bounding rect — so that is the one thing a DOM without layout has to answer
// for windowing to engage at all. Rows report the height their own estimate
// predicted, which keeps the totals exact and independent of which rows happen
// to have been mounted long enough to be measured; `layout.measuredRowHeights` is how a
// case says a row measures as something else.
//
// `scrollGeometry` additionally gives the scroll root a document to scroll: a
// height, a viewport, and a `scrollTop` that clamps the way a real one does.
// Off by default, because a transcript with a real document opens pinned to its
// bottom and the cases above are about where the window sits, not where it lands.
export function stubLayout({
  scrollGeometry = false,
  offsetChain = false,
  viewportHeight = () => VIEWPORT_PX,
  isVisible = () => true
}: {
  scrollGeometry?: boolean
  /** Give the spacer an `offsetTop` and a chain to walk up to the scroll root,
   *  so `scrollMargin` can be something other than zero. */
  offsetChain?: boolean
  viewportHeight?: () => number
  /** A hidden transcript measures as nothing, the way `display: none` does. */
  isVisible?: () => boolean
} = {}): () => void {
  let scrollTops = new WeakMap<HTMLElement, number>()
  let wasLaidOut = isVisible()
  /** Losing the box drops the retained offset, the way `display: none` does in a
   *  browser: a revealed pane reads a reader's place back only if production
   *  restored it. */
  const laidOut = (): boolean => {
    const nowLaidOut = isVisible()
    if (wasLaidOut && !nowLaidOut) {
      scrollTops = new WeakMap()
    }
    wasLaidOut = nowLaidOut
    return nowLaidOut
  }
  const restores = [
    overrideLayoutProperty('offsetHeight', {
      get(this: HTMLElement): number {
        if (!laidOut()) {
          return 0
        }
        if (this.hasAttribute('data-native-chat-scroll')) {
          return viewportHeight()
        }
        if (this.hasAttribute('data-native-chat-window')) {
          return reservedTranscriptHeight(this.parentElement ?? this)
        }
        const index = this.dataset.index
        if (index !== undefined) {
          return layout.measuredRowHeights[Number(index)] ?? ROW_PX
        }
        // The transcript column: as tall as the window it wraps, plus what sits
        // under it. This is the element the list observes for streamed growth.
        return this.classList.contains('max-w-4xl')
          ? reservedTranscriptHeight(this) + layout.belowTranscriptPx
          : 0
      }
    })
  ]
  if (scrollGeometry) {
    restores.push(
      overrideLayoutProperty('clientHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll') && laidOut() ? viewportHeight() : 0
        }
      }),
      overrideLayoutProperty('scrollHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll') && laidOut()
            ? layout.aboveTranscriptPx + reservedTranscriptHeight(this) + layout.belowTranscriptPx
            : 0
        }
      }),
      overrideLayoutProperty('scrollTop', {
        get(this: HTMLElement): number {
          if (this.hasAttribute('data-native-chat-scroll') && !laidOut()) {
            return 0
          }
          return scrollTops.get(this) ?? 0
        },
        set(this: HTMLElement, value: number): void {
          if (this.hasAttribute('data-native-chat-scroll') && !laidOut()) {
            return
          }
          // A browser clamps; without this `scrollTop = scrollHeight` would park
          // the view past the end and every distance-from-bottom would read 0.
          const max = Math.max(0, this.scrollHeight - this.clientHeight)
          scrollTops.set(this, Math.min(Math.max(0, value), max))
        }
      })
    )
  }
  if (offsetChain) {
    restores.push(
      overrideLayoutProperty('offsetTop', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-window') ? layout.aboveTranscriptPx : 0
        }
      }),
      // happy-dom has no `offsetParent` at all, so production's walk to the
      // scroll root ends before it starts and every margin reads zero.
      overrideLayoutProperty('offsetParent', {
        get(this: HTMLElement): HTMLElement | null {
          return this.parentElement?.closest<HTMLElement>('[data-native-chat-scroll]') ?? null
        }
      })
    )
  }
  return () => {
    for (const restore of restores.toReversed()) {
      restore()
    }
  }
}

type FakeResizeObservation = {
  callback: ResizeObserverCallback
  /** Target -> height last delivered. -1 means "never", so the first flush
   *  delivers, the way a real observer's initial callback does. */
  observed: Map<Element, number>
}

const resizeObservations = new Set<FakeResizeObservation>()

/** happy-dom's ResizeObserver never fires, so nothing that re-measures ever runs.
 *  This one records what production observes and delivers only when a target's
 *  height actually changed — the browser's own rule — and only when a test says
 *  a frame was painted. Entries carry no `borderBoxSize`, so the virtualizer
 *  falls back to `offsetHeight`, which is the path being modelled. */
export function stubResizeObserver(): () => void {
  const original = window.ResizeObserver
  class TestResizeObserver {
    private readonly observation: FakeResizeObservation
    constructor(callback: ResizeObserverCallback) {
      this.observation = { callback, observed: new Map() }
      resizeObservations.add(this.observation)
    }
    observe(target: Element): void {
      this.observation.observed.set(target, -1)
    }
    unobserve(target: Element): void {
      this.observation.observed.delete(target)
    }
    disconnect(): void {
      this.observation.observed.clear()
      resizeObservations.delete(this.observation)
    }
  }
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
  return () => {
    resizeObservations.clear()
    window.ResizeObserver = original
  }
}

/** Deliver one round of resize callbacks; true when anything was delivered. */
export function deliverResizes(): boolean {
  let delivered = false
  // A copy: a callback may disconnect its own observer mid-delivery.
  for (const observation of Array.from(resizeObservations)) {
    const entries: ResizeObserverEntry[] = []
    for (const [target, lastHeight] of observation.observed) {
      const height = (target as HTMLElement).offsetHeight
      if (height !== lastHeight) {
        observation.observed.set(target, height)
        entries.push({ target } as unknown as ResizeObserverEntry)
      }
    }
    if (entries.length > 0) {
      delivered = true
      observation.callback(entries, undefined as unknown as ResizeObserver)
    }
  }
  return delivered
}

export function session(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

export function list(messages: NativeChatMessage[], isVisible = true): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={session(messages)}
      isVisible={isVisible}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

/** Reads the window, and refuses to pass if there is no window to read.
 *
 *  Without this a change to the usability gate would quietly send every case
 *  below down the whole-transcript path, where "fewer rows than messages" is
 *  false but every other assertion still holds. */
export function windowState(container: HTMLElement): { totalSize: number; indexes: number[] } {
  const spacer = container.querySelector<HTMLElement>('[data-native-chat-window]')
  if (!spacer) {
    throw new Error('transcript is not windowed: no spacer, every row is mounted')
  }
  const totalSize = Number.parseFloat(spacer.style.height)
  if (!(totalSize > 0)) {
    throw new Error(`transcript reserved no height (${spacer.style.height})`)
  }
  return {
    totalSize,
    indexes: Array.from(container.querySelectorAll<HTMLElement>('[data-index]'))
      .map((row) => Number(row.dataset.index))
      .sort((left, right) => left - right)
  }
}

/** happy-dom fires no scroll event for an assignment to `scrollTop`. */
export function scrollTranscript(container: HTMLElement, top: number): void {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}
