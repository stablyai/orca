// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { useMemo } from 'react'
import { expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionLatestTurn,
  AgentSessionSubscribeEvent
} from '../../agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'
import { createStructuredAgentTurnBarsSelector } from '../structured-agent-session-turn-timing'
import type {
  StructuredAgentSessionAction,
  StructuredAgentSessionState
} from './structured-agent-session-reducer'
import type {
  SubmissionReceipts,
  StructuredAgentSubmission
} from '../structured-agent-session-submissions'
import type { NativeChatTurnJournal } from '../../../native-chat/transcript/turns/native-chat-turn-membership'

type DeliveryOwner = {
  subscribeDelivery: (listener: () => void) => () => void
  getSubmissionReceipts: () => SubmissionReceipts
}
type MobileSending = {
  receipts: { subscribe: DeliveryOwner['subscribeDelivery']; getSnapshot: () => SubmissionReceipts }
  pending: readonly []
  submissions: readonly StructuredAgentSubmission[]
}

const { useMobileStructuredAgentTurnTiming } = await vi.importActual<{
  useMobileStructuredAgentTurnTiming: (
    state: StructuredAgentSessionState,
    turnId: string | null,
    items: readonly AgentJournalRenderItem[]
  ) => { turnJournal: NativeChatTurnJournal }
}>(
  '../../../../../mobile/src/session/native-chat/transcript/ingestion/use-mobile-structured-agent-turn-timing'
)
const { useMobileStructuredSendingItemIds } = await vi.importActual<{
  useMobileStructuredSendingItemIds: (sending: MobileSending) => ReadonlySet<string>
}>(
  '../../../../../mobile/src/session/native-chat/transcript/ingestion/use-mobile-structured-sending-item-ids'
)
const { createMobileStructuredChatStateCache } = await vi.importActual<{
  createMobileStructuredChatStateCache: () => {
    get: (key: string) => StructuredAgentSessionState | undefined
    getSnapshot: (key: string) => StructuredAgentSessionState | undefined
    subscribe: (key: string, listener: () => void) => () => void
    subscribeDelivery: (key: string, listener: () => void) => () => void
    apply: (
      key: string,
      stored: () => null,
      action: StructuredAgentSessionAction,
      receivedAt: number
    ) => void
  }
}>('../../../../../mobile/src/session/native-chat/agent-session/mobile-structured-chat-state-cache')
const { useNativeChatTurnStatus } = await vi.importActual<{
  useNativeChatTurnStatus: (args: {
    turnKeys: readonly string[]
    liveTurnKey: string | undefined
    working: boolean
    journalItems: readonly AgentJournalRenderItem[]
    latestTurn: AgentSessionLatestTurn | null | undefined
    subagentId: null
    notices: undefined
    sendingItemIds: ReadonlySet<string>
    displayedIds: ReadonlySet<string>
    workingStartedAt: number | null
  }) => { turnWorking: boolean; turnStatuses: object }
}>('../../../../renderer/src/components/native-chat/conversation/turns/use-native-chat-turn-status')
const { useStructuredAgentSendingItemIds } = await vi.importActual<{
  useStructuredAgentSendingItemIds: (
    owner: DeliveryOwner,
    pending: readonly [],
    submissions: readonly StructuredAgentSubmission[]
  ) => ReadonlySet<string>
}>(
  '../../../../renderer/src/components/native-chat/session/structured/delivery/use-structured-agent-sending-item-ids'
)

vi.mock(
  '../../../../renderer/src/components/native-chat/session/structured/read/structured-agent-session-read-transport',
  () => ({
    startStructuredAgentSessionReadTransport: vi.fn()
  })
)

vi.mock(
  '../../../../../mobile/src/session/native-chat/agent-session/structured-session-operation-id',
  () => ({
    structuredSessionOperationId: () => 'receipt-test'
  })
)

const { createReadOwner } = await vi.importActual<{
  createReadOwner: (
    key: string,
    sessionId: string,
    target: { kind: 'local' }
  ) => DeliveryOwner & {
    getSnapshot: () => object
    getReadCursor: () => { epoch: string; sequence: number } | null
    subscribe: DeliveryOwner['subscribeDelivery']
    publishCreated: (page: AgentSessionHistoryPage) => void
    activate: (effects: {
      getState: () => { settings: null }
      subscribeRetryNow: () => () => void
    }) => () => void
    dispose: () => void
  }
}>(
  '../../../../renderer/src/components/native-chat/session/structured/read/structured-agent-session-read-owner-create'
)
const { startStructuredAgentSessionReadTransport } = await vi.importMock<{
  startStructuredAgentSessionReadTransport: (args: {
    applyEvent: (event: AgentSessionSubscribeEvent) => void
  }) => {
    dispose: () => void
    captureHistoryReadGuard: () => () => boolean
  }
}>(
  '../../../../renderer/src/components/native-chat/session/structured/read/structured-agent-session-read-transport'
)

const EPOCH = 'receipt-epoch'
const SEND: AgentJournalSubmission = {
  clientMessageId: 'opener',
  fence: 2,
  payloadFingerprint: 'test',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 1000,
  resolvedAt: null,
  handedOverAt: 1400
}

function page(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  const cursor = (item: AgentJournalRenderItem | undefined) =>
    item ? { epoch: EPOCH, sequence: item.sequence } : null
  const oldest = cursor(items[0])
  const newest = cursor(items.at(-1))
  return {
    sessionId: 'chat',
    epoch: EPOCH,
    direction: 'before',
    items,
    removedItemIds: [],
    submissions,
    window: { oldest, newest, nextCursor: newest ?? { epoch: EPOCH, sequence: 0 } },
    hasOlder: true,
    hasNewer: false
  } satisfies AgentSessionHistoryPage
}

function batch(
  sequence: number,
  submissions: AgentJournalSubmission[],
  items: AgentJournalRenderItem[] = [],
  latestTurn?: AgentSessionLatestTurn | null
): StructuredAgentSessionAction {
  return {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 'chat',
      latestTurn,
      actionablePromptIds: [],
      working: latestTurn != null,
      batch: { cursor: { epoch: EPOCH, sequence }, items, removedItemIds: [], submissions }
    }
  }
}

const NO_PENDING = [] as const
const NO_TURN_KEYS: string[] = []
const DISPLAYED = new Set(['orca:opener', 'orca:steer'])
const noSubscription = () => () => {}

type MobileRead = {
  state: StructuredAgentSessionState
  submissionReceipts: MobileSending['receipts']
}

type MobileClient = {
  getState: () => 'connected'
  onStateChange: typeof noSubscription
  sendRequest: (method: string) => Promise<{ ok: true; result: unknown }>
  subscribe: (
    method: string,
    options: unknown,
    receive: (event: AgentSessionSubscribeEvent) => void
  ) => () => void
}
const { useMobileStructuredAgentState } = await vi.importActual<{
  useMobileStructuredAgentState: (input: {
    client: MobileClient
    sessionId: string
    sessionKey: string
    connected: true
    enabled: true
  }) => MobileRead
}>('../../../../../mobile/src/session/native-chat/agent-session/use-mobile-structured-agent-state')
const { useMobileStructuredTurnIndicator } = await vi.importActual<{
  useMobileStructuredTurnIndicator: (input: {
    state: StructuredAgentSessionState
    turnId: string | null
    isWorking: boolean
    canStop: boolean
    hostStopping: boolean
    stopPressed: boolean
    queueCapable: boolean
    queueFollowUps: boolean
    queueSendsNext: boolean
  }) => { thinking: boolean }
}>(
  '../../../../../mobile/src/session/native-chat/transcript/ingestion/use-mobile-structured-turn-indicator'
)
const { useMobileStructuredTranscript } = await vi.importActual<{
  useMobileStructuredTranscript: (
    input: {
      agent: string
      read: MobileRead
      optimistic: readonly []
      sessionKey: string
      turnId: string | null
    },
    isWorking: boolean
  ) => { sending: MobileSending }
}>(
  '../../../../../mobile/src/session/native-chat/transcript/ingestion/use-mobile-structured-transcript'
)

// PR #45057: the production phone session used to wake and scan the whole window on a receipt.
it.each([4096, 40960])(
  'keeps the mounted mobile session asleep on receipt with %i loaded rows',
  async (rowCount) => {
    vi.useFakeTimers()
    let rowReads = 0
    let sessionRenders = 0
    const streams = new Map<string, (event: AgentSessionSubscribeEvent) => void>()
    const client: MobileClient = {
      getState: () => 'connected',
      onStateChange: noSubscription,
      sendRequest: async () => ({ ok: true, result: null }),
      subscribe: (method, _options, receive) => {
        streams.set(method, receive)
        return () => {
          streams.delete(method)
        }
      }
    }
    const items = Array.from({ length: rowCount }, (_, index): AgentJournalRenderItem => ({
      itemId: `history:${index}`,
      revision: 0,
      sequence: index + 2,
      observedAt: 1000,
      get body(): AgentJournalRenderItem['body'] {
        rowReads += 1
        return { kind: 'message', role: 'assistant', blocks: [] }
      }
    }))
    const latestTurn = {
      itemId: 'turn-lifecycle:run',
      observedAt: 1000,
      turn: { turnId: 'run', state: 'running', startedAt: 1000, userItemId: 'orca:opener' }
    } satisfies AgentSessionLatestTurn
    const session = renderHook(() => {
      sessionRenders += 1
      const read = useMobileStructuredAgentState({
        client,
        sessionId: 'chat',
        sessionKey: 'chat',
        enabled: true,
        connected: true
      })
      const { state } = read
      const turnId = state.latestTurn?.turn.turnId ?? null
      const isWorking = state.working === true
      const { sending } = useMobileStructuredTranscript(
        {
          agent: 'claude',
          sessionKey: 'chat',
          read,
          optimistic: NO_PENDING,
          turnId
        },
        isWorking
      )
      const turnIndicator = useMobileStructuredTurnIndicator({
        state,
        turnId,
        isWorking,
        canStop: isWorking,
        hostStopping: false,
        stopPressed: false,
        queueCapable: true,
        queueFollowUps: true,
        queueSendsNext: false
      })
      return { state, sending, turnIndicator }
    })
    try {
      await act(async () => vi.advanceTimersByTimeAsync(150))
      const receive = streams.get('agentSession.subscribe')!
      act(() =>
        receive({
          type: 'snapshot',
          sessionId: 'chat',
          page: { ...page(items, [SEND]), latestTurn, actionablePromptIds: [], working: true },
          fence: SEND.fence
        })
      )
      expect(session.result.current.state.items).toHaveLength(rowCount)
      expect(session.result.current.turnIndicator.thinking).toBe(false)
      const sending = renderHook(() =>
        useMobileStructuredSendingItemIds(session.result.current.sending)
      )
      try {
        expect(sending.result.current).toEqual(new Set(['orca:opener']))
        const sequence = rowCount + 2
        const deliverBatch = async (action: StructuredAgentSessionAction) => {
          if (action.type !== 'event') {
            throw new Error('Expected a subscription event')
          }
          await act(async () => {
            receive(action.event)
            await vi.advanceTimersByTimeAsync(16)
          })
        }
        rowReads = 0
        sessionRenders = 0
        await deliverBatch(batch(sequence, [{ ...SEND, writtenAt: 2000 }], [], latestTurn))
        expect({ sessionRenders, rowReads }).toEqual({ sessionRenders: 0, rowReads: 0 })
        expect(sending.result.current.size).toBe(0)

        await deliverBatch(
          batch(
            sequence + 1,
            [],
            [
              {
                itemId: 'reasoning',
                revision: 0,
                sequence: sequence + 1,
                observedAt: 2500,
                body: { kind: 'message', role: 'reasoning', state: 'running', blocks: [] }
              }
            ],
            latestTurn
          )
        )
        expect(rowReads).toBeGreaterThan(0)
        expect(session.result.current.turnIndicator.thinking).toBe(true)
      } finally {
        sending.unmount()
      }
    } finally {
      session.unmount()
      vi.useRealTimers()
    }
  }
)

// PR #45057: receipt publication used to rebuild turn membership and projection on both clients.
it.each([
  [4096, 4096, 3, false],
  [40960, 4096, 3, false],
  [4096, 40960, 3, false],
  [4096, 4096, 30, false],
  [4096, 4096, 3, true],
  [40960, 40960, 30, true]
])(
  'keeps receipt work bounded with %i rows, %i submissions, %i cached chats (running=%s)',
  (rowCount, submissionCount, cacheCount, running) => {
    let rowReads = 0
    let settledReads = 0
    const items = Array.from({ length: rowCount }, (_, index): AgentJournalRenderItem => ({
      itemId: `history:${index}`,
      revision: 0,
      sequence: index + 2,
      observedAt: 1000,
      get body(): AgentJournalRenderItem['body'] {
        rowReads += 1
        return { kind: 'message', role: 'assistant', blocks: [] }
      }
    }))
    const sequence = rowCount + 2
    const turnId = running ? 'run' : null
    const latestTurn = running
      ? ({
          itemId: 'turn-lifecycle:run',
          observedAt: 3000,
          turn: { turnId: 'run', state: 'running', startedAt: 3000, userItemId: 'orca:opener' }
        } satisfies AgentSessionLatestTurn)
      : null
    const steer = { ...SEND, clientMessageId: 'steer', submittedAt: 3200 }
    const held = {
      ...steer,
      clientMessageId: 'held',
      handedOverAt: undefined,
      handoverRecorded: true as const,
      queuedMessageId: 'held-card'
    }
    const history = Array.from({ length: submissionCount - 3 }, (_, index) => ({
      ...SEND,
      clientMessageId: `settled:${index}`,
      dispatchState: 'accepted' as const
    }))
    const cache = createMobileStructuredChatStateCache()
    const noStored = () => null
    const update = (key: string, action: StructuredAgentSessionAction) =>
      cache.apply(key, noStored, action, 5000)
    const inactive = vi.fn()
    for (let index = 1; index < cacheCount; index++) {
      const key = `chat-${index}`
      update(key, { type: 'history-page', page: page([], []) })
      cache.subscribe(key, inactive)
    }
    update('chat', {
      type: 'history-page',
      page: {
        ...page(items, [SEND, steer, held, ...history]),
        latestTurn,
        actionablePromptIds: [],
        working: running
      }
    })
    const active = vi.fn()
    const delivery = vi.fn()
    cache.subscribe('chat', active)
    cache.subscribeDelivery('chat', delivery)
    const initial = cache.get('chat')!
    const selectTurnBars = createStructuredAgentTurnBarsSelector()
    const timingOf = (state: StructuredAgentSessionState) =>
      selectTurnBars(state.items, state.submissions, turnId, state.latestTurn)
    const before = timingOf(initial)
    const { result, rerender, unmount } = renderHook(
      ({ state }) => {
        const owner = {
          subscribeDelivery: noSubscription,
          getSubmissionReceipts: () => state.writtenAtById
        } satisfies DeliveryOwner
        const desktopSending = useStructuredAgentSendingItemIds(
          owner,
          NO_PENDING,
          state.submissions
        )
        const desktop = useNativeChatTurnStatus({
          turnKeys: NO_TURN_KEYS,
          liveTurnKey: turnId ?? undefined,
          working: running,
          journalItems: state.items,
          latestTurn: state.latestTurn,
          subagentId: null,
          notices: undefined,
          sendingItemIds: desktopSending,
          displayedIds: DISPLAYED,
          workingStartedAt: running ? 3000 : null
        })
        const mobile = useMobileStructuredAgentTurnTiming(state, turnId, state.items)
        const mobileDelivery = useMemo(
          () => ({
            receipts: { subscribe: noSubscription, getSnapshot: () => state.writtenAtById },
            submissions: state.submissions,
            pending: NO_PENDING
          }),
          [state.submissions, state.writtenAtById]
        )
        const mobileSending = useMobileStructuredSendingItemIds(mobileDelivery)
        return { desktop, desktopSending, mobile, mobileSending }
      },
      { initialProps: { state: initial } }
    )
    try {
      const first = result.current
      expect(first.desktopSending).toEqual(DISPLAYED)
      expect(first.mobileSending).toEqual(DISPLAYED)
      expect(first.desktop.turnWorking).toBe(false)
      // Detect scans of settled candidates even when they never access a row body.
      for (const record of initial.submissions.slice(3)) {
        Object.defineProperty(record, 'dispatchState', {
          get: () => {
            settledReads += 1
            return 'accepted'
          }
        })
      }

      rowReads = 0
      const receipt = { ...SEND, writtenAt: 2000 }
      const mapIterations = vi.spyOn(Map.prototype, Symbol.iterator)
      try {
        update('chat', batch(sequence, [receipt], [], latestTurn))
        expect(mapIterations).not.toHaveBeenCalled()
      } finally {
        mapIterations.mockRestore()
      }
      const stamped = cache.get('chat')!
      expect(stamped.submissions).toBe(initial.submissions)
      expect(stamped.items).toBe(initial.items)
      expect(stamped.latestTurn).toBe(initial.latestTurn)
      expect(timingOf(stamped)).toBe(before)
      const receiptReads = vi.spyOn(stamped.writtenAtById, 'get')
      rerender({ state: stamped })
      expect(active).not.toHaveBeenCalled()
      expect(cache.getSnapshot('chat')).toBe(initial)
      expect(delivery).toHaveBeenCalledTimes(1)
      expect(inactive).not.toHaveBeenCalled()
      expect(receiptReads).toHaveBeenCalledTimes(4)
      expect({ rowReads, settledReads }).toEqual({ rowReads: 0, settledReads: 0 })
      expect(result.current.mobile.turnJournal).toBe(first.mobile.turnJournal)
      expect(result.current.desktop.turnStatuses).toBe(first.desktop.turnStatuses)
      expect(result.current.desktopSending).toEqual(new Set(['orca:steer']))
      expect(result.current.mobileSending).toEqual(new Set(['orca:steer']))
      expect(result.current.desktop.turnWorking).toBe(false)

      update('chat', batch(sequence + 1, [{ ...steer, writtenAt: 3500 }], [], latestTurn))
      rerender({ state: cache.get('chat')! })
      expect(result.current.desktopSending.size).toBe(0)
      expect(result.current.mobileSending.size).toBe(0)
      expect(result.current.desktop.turnWorking).toBe(running)
      expect(result.current.desktop.turnStatuses).toBe(first.desktop.turnStatuses)
      expect(result.current.mobile.turnJournal).toBe(first.mobile.turnJournal)
      expect({ rowReads, settledReads }).toEqual({ rowReads: 0, settledReads: 0 })

      update(
        'chat',
        batch(
          sequence + 2,
          [{ ...steer, fence: 3 }],
          [
            {
              itemId: 'orca:steer',
              revision: 0,
              sequence: sequence + 2,
              observedAt: 5000,
              body: { kind: 'message', role: 'user', blocks: [] }
            }
          ],
          latestTurn
        )
      )
      rerender({ state: cache.get('chat')! })
      expect(active).toHaveBeenCalledTimes(1)
      expect(result.current.mobile.turnJournal).not.toBe(first.mobile.turnJournal)
      expect(cache.get('chat')!.submissions).not.toBe(initial.submissions)
      expect(result.current.desktopSending).toEqual(new Set(['orca:steer']))
      expect(result.current.desktop.turnWorking).toBe(false)
      expect(rowReads).toBeGreaterThan(0)
    } finally {
      unmount()
    }
  }
)

// PR #45057: desktop transcript subscribers stay asleep as the delivery cursor advances.
it('publishes only delivery updates to desktop subscribers for receipts', () => {
  const transport = vi.mocked(startStructuredAgentSessionReadTransport)
  transport.mockReturnValue({
    dispose: () => {},
    captureHistoryReadGuard: () => () => false
  })
  const owner = createReadOwner('chat', 'chat', { kind: 'local' })
  owner.publishCreated({
    ...page([], [SEND]),
    latestTurn: null,
    actionablePromptIds: [],
    working: false
  })
  const release = owner.activate({
    getState: vi.fn().mockReturnValue({ settings: null }),
    subscribeRetryNow: noSubscription
  })
  const deliver = (action: StructuredAgentSessionAction) => {
    if (action.type !== 'event') {
      throw new Error('Expected a subscription event')
    }
    transport.mock.calls.at(-1)![0].applyEvent(action.event)
  }
  deliver(batch(1, [], [], null))
  const previous = owner.getSnapshot()
  const bulk = vi.fn()
  const delivery = vi.fn()
  const unsubscribeBulk = owner.subscribe(bulk)
  const unsubscribeDelivery = owner.subscribeDelivery(delivery)
  try {
    deliver(batch(2, [{ ...SEND, writtenAt: 2000 }], [], null))
    expect(owner.getSnapshot()).toBe(previous)
    expect(owner.getReadCursor()).toEqual({ epoch: EPOCH, sequence: 2 })
    expect(owner.getSubmissionReceipts().get('opener')).toBe(2000)
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(bulk).not.toHaveBeenCalled()

    deliver(batch(3, [{ ...SEND, fence: 3 }], [], null))
    expect(owner.getSnapshot()).not.toBe(previous)
    expect(owner.getSubmissionReceipts().get('opener')).toBeUndefined()
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(bulk).toHaveBeenCalledTimes(1)
  } finally {
    unsubscribeBulk()
    unsubscribeDelivery()
    release()
    owner.dispose()
  }
})
