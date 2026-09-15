// @vitest-environment happy-dom

import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

const VIEWPORT_PX = 600

export const TRANSCRIPT_LENGTH = 200

/** Everything the document holds below the last row: the transcript column's
 *  trailing chrome and the scroll root's bottom padding. Non-zero on purpose —
 *  the document's bottom sits past the window's last row, which is exactly where
 *  a pin computed from the virtualizer's totals and one computed from the
 *  document disagree. */
const BELOW_TRANSCRIPT_PX = 24
let belowTranscriptPx = BELOW_TRANSCRIPT_PX

/** Everything the document holds above the spacer: the scroll root's top gutter,
 *  and the "load earlier" block whenever there is older history to page in. This
 *  is the virtualizer's `scrollMargin`, and it is the larger half of the gap
 *  between the document's end and the end the virtualizer computes. */
let aboveTranscriptPx = 0

/** Heights the stubbed layout reports per row index, when a case wants a row to
 *  measure as something other than its estimate. Empty means "every row at its
 *  estimate", which is what every non-growth case wants. */
let measuredRowHeights: readonly number[] = []

export function marker(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `marker-${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

const ROW_PX = estimateNativeChatRowHeight(nativeChatRowContentMetrics(marker(0)), {
  hasReceipt: false,
  hasStatus: false,
  hasTurnDiff: false
})

/** Replace a layout property on every element, and hand back the undo. */
function overrideLayoutProperty(name: string, descriptor: PropertyDescriptor): () => void {
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
function reservedTranscriptHeight(root: ParentNode): number {
  const spacer = root.querySelector<HTMLElement>('[data-native-chat-window]')
  return spacer ? Number.parseFloat(spacer.style.height) || 0 : 0
}

// The virtualizer measures with `offsetHeight` — not `clientHeight`, not a
// bounding rect — so that is the one thing a DOM without layout has to answer
// for windowing to engage at all. Rows report the height their own estimate
// predicted, which keeps the totals exact and independent of which rows happen
// to have been mounted long enough to be measured; `measuredRowHeights` is how a
// case says a row measures as something else.
//
// `scrollGeometry` additionally gives the scroll root a document to scroll: a
// height, a viewport, and a `scrollTop` that clamps the way a real one does.
// Off by default, because a transcript with a real document opens pinned to its
// bottom and the cases above are about where the window sits, not where it lands.
export function stubLayout({
  scrollGeometry = false,
  offsetChain = false,
  viewportHeight = () => VIEWPORT_PX
}: {
  scrollGeometry?: boolean
  /** Give the spacer an `offsetTop` and a chain to walk up to the scroll root,
   *  so `scrollMargin` can be something other than zero. */
  offsetChain?: boolean
  viewportHeight?: () => number
} = {}): () => void {
  const scrollTops = new WeakMap<HTMLElement, number>()
  const restores = [
    overrideLayoutProperty('offsetHeight', {
      get(this: HTMLElement): number {
        if (this.hasAttribute('data-native-chat-scroll')) {
          return viewportHeight()
        }
        if (this.hasAttribute('data-native-chat-window')) {
          return reservedTranscriptHeight(this.parentElement ?? this)
        }
        const index = this.dataset.index
        if (index !== undefined) {
          return measuredRowHeights[Number(index)] ?? ROW_PX
        }
        // The transcript column: as tall as the window it wraps, plus what sits
        // under it. This is the element the list observes for streamed growth.
        return this.classList.contains('max-w-4xl')
          ? reservedTranscriptHeight(this) + belowTranscriptPx
          : 0
      }
    })
  ]
  if (scrollGeometry) {
    restores.push(
      overrideLayoutProperty('clientHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll') ? viewportHeight() : 0
        }
      }),
      overrideLayoutProperty('scrollHeight', {
        get(this: HTMLElement): number {
          return this.hasAttribute('data-native-chat-scroll')
            ? aboveTranscriptPx + reservedTranscriptHeight(this) + belowTranscriptPx
            : 0
        }
      }),
      overrideLayoutProperty('scrollTop', {
        get(this: HTMLElement): number {
          return scrollTops.get(this) ?? 0
        },
        set(this: HTMLElement, value: number): void {
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
          return this.hasAttribute('data-native-chat-window') ? aboveTranscriptPx : 0
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

export function list(messages: NativeChatMessage[]): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={session(messages)}
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
