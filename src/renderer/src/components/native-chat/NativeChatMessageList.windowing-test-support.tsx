// @vitest-environment happy-dom

import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { transcriptRowOffset, transcriptWindowHeight } from './native-chat-window-test-layout'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

const VIEWPORT_PX = 600

export const TRANSCRIPT_LENGTH = 200

/** Nonzero trailing chrome exposes disagreement between document end and virtualizer totals. */
const BELOW_TRANSCRIPT_PX = 24
let belowTranscriptPx = BELOW_TRANSCRIPT_PX

/** In-flow chrome above the spacer supplies scrollMargin and offsets the document end. */
let aboveTranscriptPx = 0

/** Override measured heights; empty means each row measures at its estimate. */
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

function reservedTranscriptHeight(root: ParentNode): number {
  return transcriptWindowHeight(root)
}

// Provide offsetHeight for measurement; optional clamped scroll geometry opens at the document end.
export function stubLayout({
  scrollGeometry = false,
  offsetChain = false,
  viewportHeight = () => VIEWPORT_PX
}: {
  scrollGeometry?: boolean
  /** Supply an offset chain so scrollMargin can be nonzero. */
  offsetChain?: boolean
  viewportHeight?: () => number
} = {}): () => void {
  const scrollTops = new WeakMap<HTMLElement, number>()
  const restores = [
    overrideLayoutProperty('clientWidth', {
      get(this: HTMLElement): number {
        return this.hasAttribute('data-native-chat-scroll') ? 800 : 0
      }
    }),
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
        // The observed column includes reserved rows and trailing chrome.
        return this.hasAttribute('data-native-chat-transcript-column')
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
          // Clamp like a browser so scrollHeight assignments cannot park past the document end.
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
          return this.hasAttribute('data-native-chat-window')
            ? aboveTranscriptPx
            : this.hasAttribute('data-index')
              ? transcriptRowOffset(this)
              : 0
        }
      }),
      // Provide the offsetParent chain missing from happy-dom so scrollMargin can be measured.
      overrideLayoutProperty('offsetParent', {
        get(this: HTMLElement): HTMLElement | null {
          return this.hasAttribute('data-index')
            ? this.parentElement
            : (this.parentElement?.closest<HTMLElement>('[data-index]') ??
                this.parentElement?.closest<HTMLElement>('[data-native-chat-scroll]') ??
                null)
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
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

export function list(messages: NativeChatMessage[]): React.JSX.Element {
  return (
    <NativeChatMessageList session={session(messages)} isWorking={false} expandSignal={false} />
  )
}

/** Fail if windowing is disabled; whole-transcript rendering would satisfy most assertions vacuously. */
export function windowState(container: HTMLElement): { totalSize: number; indexes: number[] } {
  const spacer = container.querySelector<HTMLElement>('[data-native-chat-window]')
  if (!spacer) {
    throw new Error('transcript is not windowed: no spacer, every row is mounted')
  }
  const totalSize = transcriptWindowHeight(container)
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
