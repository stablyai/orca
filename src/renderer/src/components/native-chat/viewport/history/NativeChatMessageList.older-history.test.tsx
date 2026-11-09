// @vitest-environment happy-dom
import { createRef, useSyncExternalStore } from 'react'
import type { NativeChatMessageListHandle } from '../../messages/actions/use-native-chat-reveal-latest'

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const historyHost = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: historyHost.call
}))

vi.mock('../../../../runtime/native-chat/requests/structured-agent-session-subscriptions', () => ({
  subscribeStructuredAgentSession: historyHost.subscribe
}))

const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('../../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import { createReadOwner } from '../../session/structured/read/structured-agent-session-read-owner-create'
import type { AgentSessionHistoryPage } from '../../../../../../shared/agent-session/agent-session-wire'
import { useAppStore } from '@/store'
import { transcriptWindowTop } from '../virtualization/native-chat-window-test-layout'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'

import {
  layout,
  marker,
  session,
  stubLayout,
  stubResizeObserver
} from '../virtualization/native-chat-windowing-test-harness'

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

  it('keeps a returned window bounded through an intersecting sentinel and resumes on manual history intent', async () => {
    restoreLayout()
    restoreLayout = stubLayout({
      scrollGeometry: true,
      offsetChain: true,
      viewportHeight: () => 50
    })
    const handle = createRef<NativeChatMessageListHandle>()
    let generation = 0
    let hasMore = true
    const loadEarlier = vi.fn(async (): Promise<NativeChatOlderPageResult> => {
      generation++
      hasMore = false
      refresh()
      return 'applied'
    })
    const trimHistory = () => {
      generation++
      refresh()
    }
    const element = () => (
      <NativeChatMessageList
        ref={handle}
        session={{
          ...session(markers(0, 3)),
          hasMore,
          loadEarlier,
          trimHistory,
          olderHistoryGeneration: generation
        }}
        isWorking={false}
        expandSignal={false}
      />
    )
    const view = render(element())
    function refresh() {
      view.rerender(element())
    }
    await settle()
    // A send while already following preserves initial autofill.
    act(() => handle.current?.revealLatest(true))
    expect(generation).toBe(0)
    const scroller = view.container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
    fireEvent.wheel(scroller, { deltaY: -20 })
    scroller.scrollTop -= 20
    fireEvent.scroll(scroller)
    // The send's near-end predicate remains true after a real departure.
    act(() => handle.current?.revealLatest(true))
    sentinelInRange = true
    deliverIntersections()
    await settle()
    deliverIntersections()
    await settle()
    expect(loadEarlier).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
    await settle()
    deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull()
  })

  it('retires shared initial autofill across two views and still pages after deliberate history intent', async () => {
    restoreLayout()
    restoreLayout = stubLayout({
      scrollGeometry: true,
      offsetChain: true,
      viewportHeight: () => 50
    })
    const page = (oldest: number, direction: 'tail' | 'before'): AgentSessionHistoryPage => ({
      sessionId: 'shared-history',
      epoch: 'epoch',
      direction,
      items: Array.from({ length: 200 }, (_, index) => ({
        itemId: `item-${oldest + index}`,
        revision: 1,
        sequence: oldest + index,
        observedAt: oldest + index,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'folded history' }]
        }
      })),
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'epoch', sequence: oldest },
        newest: { epoch: 'epoch', sequence: oldest + 199 },
        nextCursor: { epoch: 'epoch', sequence: oldest }
      },
      liveCursor: { epoch: 'epoch', sequence: 2000 },
      hasOlder: true,
      hasNewer: false
    })
    historyHost.subscribe.mockResolvedValue({ unsubscribe: () => {} })
    historyHost.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.history') {
        throw new Error('Unexpected host call')
      }
      return { ok: true, page: page(params.cursor.sequence - 200, 'before') }
    })
    const owner = createReadOwner('shared-history-test', 'shared-history', { kind: 'local' })
    owner.publishCreated(page(1801, 'tail'))
    const deactivate = owner.activate({
      getState: useAppStore.getState,
      subscribeRetryNow: () => () => {}
    })
    const handle = createRef<NativeChatMessageListHandle>()
    function View({ first = false }: { first?: boolean }) {
      const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot)
      return (
        <NativeChatMessageList
          ref={first ? handle : undefined}
          session={{
            ...session(markers(0, 3)),
            sessionId: 'shared-history',
            hasMore: snapshot.state.hasOlder,
            loadingEarlier: snapshot.loadingOlder,
            olderHistoryGeneration: snapshot.olderHistoryGeneration,
            initialHistoryAutoLoad: snapshot.initialHistoryAutoLoad,
            retainHistory: owner.retainHistory,
            trimHistory: owner.trimHistory,
            loadEarlier: owner.loadOlder
          }}
          isWorking={false}
          expandSignal={false}
        />
      )
    }
    try {
      // Prime expanded source history before the live edge becomes intersecting.
      for (let pageIndex = 0; pageIndex < 6; pageIndex++) {
        await owner.loadOlder()
      }
      const view = render(
        <>
          <View first />
          <View />
        </>
      )
      await settle()
      historyHost.call.mockClear()
      const scroller = view.container.querySelector<HTMLElement>('[data-native-chat-scroll]')!
      fireEvent.wheel(scroller, { deltaY: -20 })
      scroller.scrollTop -= 20
      fireEvent.scroll(scroller)
      act(() => handle.current?.revealLatest(true))
      expect(owner.getSnapshot().state.items).toHaveLength(1024)
      sentinelInRange = true
      deliverIntersections()
      await settle()
      deliverIntersections()
      await settle()
      expect(historyHost.call).not.toHaveBeenCalled()
      fireEvent.click(screen.getAllByRole('button', { name: 'Load earlier messages' })[1]!)
      await settle()
      expect(historyHost.call).toHaveBeenCalledOnce()
      expect(owner.getSnapshot().state.items).toHaveLength(1224)
      view.unmount()
    } finally {
      deactivate()
      owner.dispose()
    }
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
