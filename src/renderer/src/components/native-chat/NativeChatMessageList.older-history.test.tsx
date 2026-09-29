// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX } from './use-native-chat-older-history-autoload'
import {
  deliverResizes,
  layout,
  marker,
  ROW_PITCH_PX,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'

// happy-dom's IntersectionObserver never reports. This one reports the way a
// browser does: once on observe, then only when the target crosses the edge.
type FakeObservation = {
  callback: IntersectionObserverCallback
  observer: IntersectionObserver
  targets: Map<Element, boolean | null>
}
const observations = new Set<FakeObservation>()
const createdObservers: { root: Element | Document | null; rootMargin: string }[] = []
/** Whether the sentinel sits inside the observer's prefetch range right now. */
let sentinelInRange = false

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly scrollMargin = '0px'
  readonly thresholds: readonly number[] = [0]
  private readonly observation: FakeObservation
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    this.observation = { callback, observer: this, targets: new Map() }
    observations.add(this.observation)
    createdObservers.push({ root: this.root, rootMargin: this.rootMargin })
  }
  observe(target: Element): void {
    this.observation.targets.set(target, null)
  }
  unobserve(target: Element): void {
    this.observation.targets.delete(target)
  }
  disconnect(): void {
    this.observation.targets.clear()
    observations.delete(this.observation)
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** One rendering opportunity's worth of intersection reports. */
function deliverIntersections(): void {
  act(() => {
    for (const observation of Array.from(observations)) {
      const entries: IntersectionObserverEntry[] = []
      for (const [target, last] of observation.targets) {
        if (last !== sentinelInRange) {
          observation.targets.set(target, sentinelInRange)
          entries.push({
            boundingClientRect: new DOMRect(),
            intersectionRatio: sentinelInRange ? 1 : 0,
            intersectionRect: new DOMRect(),
            isIntersecting: sentinelInRange,
            rootBounds: null,
            target,
            time: 0
          })
        }
      }
      if (entries.length > 0) {
        observation.callback(entries, observation.observer)
      }
    }
  })
}

async function settle(): Promise<void> {
  await act(async () => {})
}

function noise(index: number): NativeChatMessage {
  // A harness-injected turn: real history the transcript strips before it has a row.
  return {
    id: `noise-${index}`,
    role: 'user',
    blocks: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

const markers = (from: number, to: number): NativeChatMessage[] =>
  Array.from({ length: to - from }, (_, offset) => marker(from + offset))

/** The scroll root's `pt-10`, and the transcript column's `gap-5`. */
const TOP_GUTTER_PX = 40
const COLUMN_GAP_PX = 20
/** Any chrome mounted in the column before the window is in flow and pushes the
 *  window down by its height and one gap, the way a flex column lays it out. */
const IN_FLOW_CHROME_PX = 32

function flowAboveSpacer(spacer: HTMLElement): number {
  let above = TOP_GUTTER_PX
  for (let node = spacer.previousElementSibling; node; node = node.previousElementSibling) {
    above += IN_FLOW_CHROME_PX + COLUMN_GAP_PX
  }
  return above
}

type LoadEarlier = () => Promise<NativeChatOlderPageResult>
const lands = (): LoadEarlier => vi.fn(async (): Promise<NativeChatOlderPageResult> => 'applied')
const neverSettles = (): LoadEarlier =>
  vi.fn(() => new Promise<NativeChatOlderPageResult>(() => {}))

function paging({
  messages,
  loadEarlier,
  hasMore = true,
  loadingEarlier = false,
  isVisible = true,
  olderHistoryGeneration = 0,
  readPhase = 'ready'
}: {
  messages: NativeChatMessage[]
  loadEarlier: LoadEarlier
  hasMore?: boolean
  loadingEarlier?: boolean
  isVisible?: boolean
  olderHistoryGeneration?: number
  readPhase?: NativeChatLiveSession['readPhase']
}): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={{
        ...session(messages),
        hasMore,
        loadingEarlier,
        loadEarlier,
        olderHistoryGeneration,
        readPhase
      }}
      isVisible={isVisible}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function scrollRoot(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  return scroller
}

function paint(container: HTMLElement): void {
  const scroller = scrollRoot(container)
  for (let pass = 0; pass < 12; pass += 1) {
    const before = scroller.scrollTop
    let resized = false
    act(() => {
      resized = deliverResizes()
    })
    if (scroller.scrollTop !== before) {
      fireEvent.scroll(scroller)
    } else if (!resized) {
      return
    }
  }
  throw new Error('the transcript never settled')
}

afterEach(cleanup)

describe('older history auto-load', () => {
  let restoreLayout = (): void => {}
  let restoreResizeObserver = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    restoreResizeObserver = stubResizeObserver()
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    observations.clear()
    createdObservers.length = 0
    sentinelInRange = false
    layout.aboveTranscriptPx = 0
    layout.aboveSpacerPx = flowAboveSpacer
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    restoreResizeObserver()
    restoreLayout()
    layout.aboveTranscriptPx = 0
    layout.aboveSpacerPx = null
  })

  it('asks for a page once the top sentinel is within prefetch range of the scroller', () => {
    const loadEarlier = lands()
    const { container } = render(paging({ messages: markers(100, 150), loadEarlier }))
    deliverIntersections()
    expect(loadEarlier).not.toHaveBeenCalled()
    expect(createdObservers.at(-1)).toEqual({
      root: scrollRoot(container),
      rootMargin: `${NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX}px 0px 0px 0px`
    })

    sentinelInRange = true
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
  })

  // A page of rows the transcript hides leaves the row count unchanged; paging
  // must continue anyway while the reader is still near the top.
  it('keeps paging after each page while the sentinel stays in range', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const { container, rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    paint(container)
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    const hiddenPage = [...Array.from({ length: 20 }, (_, index) => noise(index)), ...base]
    rerender(paging({ messages: hiddenPage, loadEarlier }))
    paint(container)
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(2)

    rerender(paging({ messages: hiddenPage, loadEarlier, loadingEarlier: true }))
    await settle()
    rerender(paging({ messages: [...markers(80, 100), ...hiddenPage], loadEarlier }))
    paint(container)
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(3)
  })

  it('stops once a page pushes the sentinel out of range', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const { container, rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()

    sentinelInRange = false
    rerender(paging({ messages: [...markers(50, 100), ...base], loadEarlier }))
    paint(container)
    deliverIntersections()
    act(() => {
      deliverResizes()
    })
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  it('stops, and shows neither status nor button, once history runs out', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    rerender(paging({ messages: [...markers(90, 100), ...base], loadEarlier, hasMore: false }))
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(observations.size).toBe(0)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
  })

  it('stops observing while the lane reports a page loading', () => {
    const loadEarlier = neverSettles()
    const base = markers(100, 150)
    const { container, rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    paint(container)
    sentinelInRange = false
    deliverIntersections()
    sentinelInRange = true
    deliverIntersections()
    expect(observations.size).toBe(0)
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  // The lane can start and abandon a read (a reconnect snapshot) before loading is
  // ever rendered; the list cannot tell that from "not reported yet", so it must
  // not hold its own latch on the outstanding read. The lane dedupes instead.
  it('asks again when the lane never reports the outstanding page as loading', () => {
    const loadEarlier = neverSettles()
    render(paging({ messages: markers(100, 150), loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    sentinelInRange = false
    deliverIntersections()
    sentinelInRange = true
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(2)
  })

  // A reconnect snapshot or a hide ends the lane's loading while its read is still
  // outstanding; the next page must not wait on a request the lane dropped.
  it('keeps paging when the lane abandons a page that never settles', async () => {
    const loadEarlier = neverSettles()
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    rerender(paging({ messages: base, loadEarlier }))
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(2)
  })

  it('does not observe a hidden transcript', () => {
    const loadEarlier = lands()
    render(paging({ messages: markers(100, 150), loadEarlier, isVisible: false }))
    sentinelInRange = true
    deliverIntersections()
    expect(observations.size).toBe(0)
    expect(loadEarlier).not.toHaveBeenCalled()
  })

  it('shows a quiet status line, with a label only once a page is slow', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const loadEarlier = lands()
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toBeEmptyDOMElement()

    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Loading earlier messages…')
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
  })

  it('offers a manual load after a failed page, and resumes auto-loading once it succeeds', async () => {
    const loadEarlier = vi
      .fn<LoadEarlier>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValue('applied')
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    await settle()

    const retry = screen.getByRole('button', { name: 'Load earlier messages' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(observations.size).toBe(0)
    sentinelInRange = false
    deliverIntersections()
    sentinelInRange = true
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    fireEvent.click(retry)
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()

    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    rerender(paging({ messages: [...markers(80, 100), ...base], loadEarlier }))
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(3)
  })

  // Without this the recreated observer would ask for the same stuck page forever.
  it('stops auto-loading, and offers a manual load, when a page made no progress', async () => {
    const loadEarlier = vi.fn<LoadEarlier>().mockResolvedValue('unchanged')
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    rerender(paging({ messages: base, loadEarlier }))
    await settle()
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(observations.size).toBe(0)
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument()
  })

  // A failure belongs to one paging generation: a reconnect or reset gives the host
  // another chance without the reader having to click.
  it('resumes auto-loading, with no click, once the lane resets its paging generation', async () => {
    const loadEarlier = vi
      .fn<LoadEarlier>()
      .mockResolvedValueOnce('failed')
      .mockResolvedValue('applied')
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    deliverIntersections()
    await settle()
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument()

    rerender(paging({ messages: base, loadEarlier, olderHistoryGeneration: 1 }))
    deliverIntersections()

    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
  })

  it('shows no older-history row while the read is not ready, and re-checks once it is', () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const { rerender } = render(paging({ messages: base, loadEarlier, readPhase: 'error' }))
    sentinelInRange = true
    deliverIntersections()

    expect(observations.size).toBe(0)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load earlier/i })).not.toBeInTheDocument()
    expect(loadEarlier).not.toHaveBeenCalled()

    rerender(paging({ messages: base, loadEarlier }))
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  /** Where a row's top sits in the scroll document. */
  function rowTop(container: HTMLElement, text: string): number {
    const row = screen.getByText(text).closest<HTMLElement>('[data-index]')
    const spacer = container.querySelector<HTMLElement>('[data-native-chat-window]')
    if (!row || !spacer) {
      throw new Error(`${text} is not a windowed row`)
    }
    return spacer.offsetTop + Number.parseFloat(row.style.top)
  }

  async function readerAtMarker140(loadEarlier: LoadEarlier) {
    const base = markers(100, 200)
    const view = render(paging({ messages: base, loadEarlier }))
    paint(view.container)
    const scroller = scrollRoot(view.container)
    const spacer = view.container.querySelector<HTMLElement>('[data-native-chat-window]')
    scrollTranscript(view.container, (spacer?.offsetTop ?? 0) + 40 * ROW_PITCH_PX + 17)
    paint(view.container)
    expect(rowTop(view.container, 'marker-140') - scroller.scrollTop).toBe(-17)

    sentinelInRange = true
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    sentinelInRange = false
    view.rerender(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    return { ...view, base, scroller }
  }

  it('keeps the row the reader is looking at in place across an auto-loaded prepend', async () => {
    const loadEarlier = lands()
    const { container, rerender, base, scroller } = await readerAtMarker140(loadEarlier)

    rerender(paging({ messages: [...markers(50, 100), ...base], loadEarlier }))
    paint(container)

    expect(rowTop(container, 'marker-140') - scroller.scrollTop).toBe(-17)
    expect(scroller.scrollTop).toBe(TOP_GUTTER_PX + 90 * ROW_PITCH_PX + 17)
  })

  // The last page takes the older-history row away with it. Anything that row
  // held in flow above the window would leave with it, and move every row.
  it('keeps the reader in place when the last page lands and the older-history row leaves', async () => {
    const loadEarlier = lands()
    const { container, rerender, base, scroller } = await readerAtMarker140(loadEarlier)

    rerender(paging({ messages: [...markers(50, 100), ...base], loadEarlier, hasMore: false }))
    paint(container)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(rowTop(container, 'marker-140') - scroller.scrollTop).toBe(-17)
  })
})
