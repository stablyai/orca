// happy-dom has no layout or observer delivery; these stubs activate real list windowing.
import { fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { transcriptRowOffset, transcriptWindowHeight } from './native-chat-window-test-layout'
import {
  estimateNativeChatRowHeight,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

export const VIEWPORT_PX = 600
export const TRANSCRIPT_LENGTH = 200

/** Nonzero trailing chrome/padding separates the document bottom from virtualizer totals to expose incorrect bottom pins. */
export const BELOW_TRANSCRIPT_PX = 24

export const layout: {
  belowTranscriptPx: number
  aboveTranscriptPx: number
  /** Derive spacer offset from mounted chrome instead of the fixed gutter for flow-layout cases. */
  aboveSpacerPx: ((spacer: HTMLElement) => number) | null
  measuredRowHeights: readonly number[]
} = {
  belowTranscriptPx: BELOW_TRANSCRIPT_PX,
  aboveTranscriptPx: 0,
  aboveSpacerPx: null,
  measuredRowHeights: []
}

function aboveTranscriptPx(spacer: HTMLElement | null): number {
  return spacer && layout.aboveSpacerPx ? layout.aboveSpacerPx(spacer) : layout.aboveTranscriptPx
}

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

export function reservedTranscriptHeight(root: ParentNode): number {
  return transcriptWindowHeight(root)
}

// Windowing needs offsetHeight; default rows match estimates, with measuredRowHeights overrides. Optional clamped scroll geometry exercises bottom pinning.
export function stubLayout({
  scrollGeometry = false,
  offsetChain = false,
  viewportHeight = () => VIEWPORT_PX,
  isVisible = () => true
}: {
  scrollGeometry?: boolean
  /** Model offsetParent/offsetTop chains so production scrollMargin can be nonzero. */
  offsetChain?: boolean
  viewportHeight?: () => number
  /** A hidden transcript measures as nothing, the way `display: none` does. */
  isVisible?: () => boolean
} = {}): () => void {
  let scrollTops = new WeakMap<HTMLElement, number>()
  let wasLaidOut = isVisible()
  /** Hidden panes lose their offset as display:none does; only production restoration may recover it. */
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
        return this.hasAttribute('data-native-chat-transcript-column')
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
            ? aboveTranscriptPx(this.querySelector<HTMLElement>('[data-native-chat-window]')) +
                reservedTranscriptHeight(this) +
                layout.belowTranscriptPx
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
          // Clamp like a browser; overscrolling would falsely make distance-from-bottom read zero.
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
            ? aboveTranscriptPx(this)
            : this.hasAttribute('data-index')
              ? transcriptRowOffset(this)
              : 0
        }
      }),
      // Model the missing happy-dom offsetParent chain so scroll margins do not silently stay zero.
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

type FakeResizeObservation = {
  callback: ResizeObserverCallback
  /** Last delivered height per target; -1 forces the initial callback. */
  observed: Map<Element, number>
}

const resizeObservations = new Set<FakeResizeObservation>()

/** Deliver resize changes only on simulated paint; omit borderBoxSize to exercise offsetHeight fallback. */
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

export function deliverResizes(accept: (target: Element) => boolean = () => true): boolean {
  let delivered = false
  // A copy: a callback may disconnect its own observer mid-delivery.
  for (const observation of Array.from(resizeObservations)) {
    const entries: ResizeObserverEntry[] = []
    for (const [target, lastHeight] of observation.observed) {
      if (!accept(target)) {
        continue
      }
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
    olderHistoryGeneration: 0,
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
    />
  )
}

/** Require active windowing so usability-gate regressions cannot pass through the whole-transcript path. */
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
  fireEvent.wheel(scroller, { deltaY: top - scroller.scrollTop })
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}
