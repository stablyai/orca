// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import { transcriptWindowTop } from './native-chat-window-test-layout'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

import {
  layout,
  marker,
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'

// Unlike happy-dom, report on observe and whenever the sentinel crosses the prefetch edge.
type FakeObservation = {
  callback: IntersectionObserverCallback
  observer: IntersectionObserver
  targets: Map<Element, boolean | null>
}
const observations = new Set<FakeObservation>()
const createdObservers: { root: Element | Document | null; rootMargin: string }[] = []
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

const markers = (from: number, to: number): NativeChatMessage[] =>
  Array.from({ length: to - from }, (_, offset) => marker(from + offset))

/** The scroll root's `pt-10`, and the transcript column's `gap-5`. */
const TOP_GUTTER_PX = 40
const COLUMN_GAP_PX = 20
/** In-flow chrome offsets the spacer by its height plus one flex-column gap. */
const IN_FLOW_CHROME_PX = 32

function flowAboveSpacer(spacer: HTMLElement): number {
  return transcriptWindowTop(spacer, TOP_GUTTER_PX, IN_FLOW_CHROME_PX + COLUMN_GAP_PX)
}

type LoadEarlier = () => Promise<NativeChatOlderPageResult>
const lands = (): LoadEarlier => vi.fn(async (): Promise<NativeChatOlderPageResult> => 'applied')

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
    />
  )
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

  // Reconnect/reset starts a new paging generation and clears that generation’s failure.
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
})
