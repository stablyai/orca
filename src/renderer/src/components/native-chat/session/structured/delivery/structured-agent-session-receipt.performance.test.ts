// @vitest-environment happy-dom

import { act, render, renderHook } from '@testing-library/react'
import { createElement, useMemo } from 'react'
import {
  createStructuredAgentSendingSource,
  type SubmissionReceiptSource
} from '../../../../../../../shared/agent-session/view/structured-agent-sending-source'
import { steeringQueuedMessageEchoes } from '../../../../../../../shared/agent-session/view/structured-agent-session-sending-queued-cards'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionLatestTurn,
  AgentSessionSubscribeEvent
} from '../../../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { createStructuredAgentTurnBarsSelector } from '../../../../../../../shared/agent-session/view/structured-agent-session-turn-timing'
import type {
  StructuredAgentSessionAction,
  StructuredAgentSessionState
} from '../../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { SubmissionReceipts } from '../../../../../../../shared/agent-session/view/structured-agent-session-submissions'
import type { NativeChatTurnJournal } from '../../../../../../../shared/native-chat/transcript/turns/native-chat-turn-membership'
import * as desktopSending from './structured-agent-sending-scope'
import { useStructuredAgentSendingSource } from './use-structured-agent-sending-source'

const { useMobileStructuredAgentTurnTiming } = await vi.importActual<{
  useMobileStructuredAgentTurnTiming: (
    state: StructuredAgentSessionState,
    turnId: string | null,
    items: readonly AgentJournalRenderItem[]
  ) => { turnJournal: NativeChatTurnJournal }
}>(
  '../../../../../../../../mobile/src/session/native-chat/transcript/ingestion/use-mobile-structured-agent-turn-timing'
)
const { createMobileStructuredChatStateCache } = await vi.importActual<{
  createMobileStructuredChatStateCache: () => {
    get: (key: string) => StructuredAgentSessionState | undefined
    getSnapshot: (key: string) => StructuredAgentSessionState | undefined
    subscribe: (key: string, listener: () => void) => () => void
    subscribeDelivery: (key: string, listener: () => void) => () => void
    receiptsFor: (
      key: string,
      epoch: string | null,
      submissions: StructuredAgentSessionState['submissions'],
      stored: null,
      published: { current: StructuredAgentSessionState }
    ) => SubmissionReceiptSource
    apply: (
      key: string,
      stored: () => null,
      action: StructuredAgentSessionAction,
      receivedAt: number
    ) => void
  }
}>(
  '../../../../../../../../mobile/src/session/native-chat/agent-session/mobile-structured-chat-state-cache'
)
const { useNativeChatTurnStatus } = await vi.importActual<{
  useNativeChatTurnStatus: (args: {
    turnKeys: readonly string[]
    liveTurnKey: string | undefined
    working: boolean
    journalItems: readonly AgentJournalRenderItem[]
    latestTurn: AgentSessionLatestTurn | null | undefined
    subagentId: null
    notices: undefined
    workingStartedAt: number | null
  }) => { turnWorking: boolean; turnStatuses: object }
}>('../../../conversation/turns/use-native-chat-turn-status')
vi.mock('../read/structured-agent-session-read-transport', () => ({
  startStructuredAgentSessionReadTransport: vi.fn()
}))

const { createReadOwner } = await import('../read/structured-agent-session-read-owner-create')
const { startStructuredAgentSessionReadTransport } = await vi.importMock<{
  startStructuredAgentSessionReadTransport: (args: {
    applyEvent: (event: AgentSessionSubscribeEvent) => void
  }) => {
    dispose: () => void
    captureHistoryReadGuard: () => () => boolean
  }
}>('../read/structured-agent-session-read-transport')

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

const NO_TURN_KEYS: string[] = []
const noSubscription = () => () => {}

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
      handoverRecorded: true as const
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
        const desktop = useNativeChatTurnStatus({
          turnKeys: NO_TURN_KEYS,
          liveTurnKey: turnId ?? undefined,
          working: running,
          journalItems: state.items,
          latestTurn: state.latestTurn,
          subagentId: null,
          notices: undefined,
          workingStartedAt: running ? 3000 : null
        })
        const mobile = useMobileStructuredAgentTurnTiming(state, turnId, state.items)
        return { desktop, mobile }
      },
      { initialProps: { state: initial } }
    )
    try {
      const first = result.current
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
      rerender({ state: stamped })
      expect(active).not.toHaveBeenCalled()
      expect(cache.getSnapshot('chat')).toBe(initial)
      expect(delivery).toHaveBeenCalledTimes(1)
      expect(inactive).not.toHaveBeenCalled()
      expect({ rowReads, settledReads }).toEqual({ rowReads: 0, settledReads: 0 })
      expect(result.current.mobile.turnJournal).toBe(first.mobile.turnJournal)
      expect(result.current.desktop.turnStatuses).toBe(first.desktop.turnStatuses)

      update('chat', batch(sequence + 1, [{ ...steer, writtenAt: 3500 }], [], latestTurn))
      rerender({ state: cache.get('chat')! })
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
      expect(rowReads).toBeGreaterThan(0)
    } finally {
      unmount()
    }
  }
)

const { NativeChatTurnActivityLine } = await vi.importActual<{
  NativeChatTurnActivityLine: React.ComponentType<{
    line: { thinking: boolean; stopping: boolean; activityText: null; reasoning: null }
  }>
}>('../../../messages/reasoning/NativeChatTurnActivityLine')

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
  const source = createStructuredAgentSendingSource(
    { subscribe: owner.subscribeReceipts, getSnapshot: owner.getSubmissionReceipts },
    [],
    previous.state.submissions
  )
  const activity = render(
    createElement(
      desktopSending.StructuredAgentSendingScope,
      { source, displayedIds: new Set(['orca:opener']) },
      createElement(NativeChatTurnActivityLine, {
        line: { thinking: false, stopping: true, activityText: null, reasoning: null }
      })
    )
  )
  const activityLines = () =>
    activity.container.querySelectorAll('[data-native-chat-turn-activity]')
  try {
    expect(activityLines()).toHaveLength(0)
    act(() => deliver(batch(2, [{ ...SEND, writtenAt: 2000 }], [], null)))
    expect(activityLines()).toHaveLength(1)
    expect(owner.getSnapshot()).toBe(previous)
    expect(owner.getReadCursor()).toEqual({ epoch: EPOCH, sequence: 2 })
    expect(owner.getSubmissionReceipts().get('opener')).toBe(2000)
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(bulk).not.toHaveBeenCalled()

    act(() => deliver(batch(3, [{ ...SEND, fence: 3 }], [], null)))
    expect(activityLines()).toHaveLength(0)
    expect(owner.getSnapshot()).not.toBe(previous)
    expect(owner.getSubmissionReceipts().get('opener')).toBeUndefined()
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(bulk).toHaveBeenCalledTimes(1)
  } finally {
    activity.unmount()
    unsubscribeBulk()
    unsubscribeDelivery()
    release()
    owner.dispose()
  }
})

const mobileSending = await vi.importActual<typeof desktopSending>(
  '../../../../../../../../mobile/src/session/native-chat/transcript/sending/structured-agent-sending-scope'
)

// PR #45057 rescanned pending submissions and their display IDs for every receipt.
it('visits only changed Sending IDs at 16 and 160 pending sends on each owner', () => {
  const emptyPending: readonly StructuredAgentSessionOptimisticMessage[] = []
  for (const size of [16, 160]) {
    for (const mobile of [false, true]) {
      const records = Array.from({ length: size }, (_, index) => ({
        ...SEND,
        clientMessageId: `send-${index}`
      }))
      const ids = records.map(({ clientMessageId }) => `orca:${clientMessageId}`)
      const history = {
        ...page([], records),
        working: false,
        latestTurn: null,
        actionablePromptIds: []
      }
      const owner = createReadOwner('chat', 'chat', { kind: 'local' })
      const transport = vi.mocked(startStructuredAgentSessionReadTransport)
      transport.mockReturnValue({ dispose: () => {}, captureHistoryReadGuard: () => () => false })
      const cache = createMobileStructuredChatStateCache()
      const release = mobile
        ? () => {}
        : owner.activate({
            getState: vi.fn().mockReturnValue({ settings: null }),
            subscribeRetryNow: noSubscription
          })
      const apply = (action: StructuredAgentSessionAction) => {
        if (mobile) {
          cache.apply('chat', () => null, action, 5000)
        } else if (action.type === 'event') {
          transport.mock.calls.at(-1)![0].applyEvent(action.event)
        } else if (action.type === 'history-page') {
          owner.publishCreated(action.page)
        }
      }
      const structural = vi.fn()
      const unsubscribe = mobile ? cache.subscribe('chat', structural) : owner.subscribe(structural)
      apply({ type: 'history-page', page: history })
      apply(batch(1, [], [], null))
      const state = mobile ? cache.get('chat')! : owner.getSnapshot().state
      const shown = new Set(ids)
      const countVisits = new Map<string, number>()
      const renders = vi.fn<(id: string) => void>()
      const notifyLeaf = vi.fn<(id: string) => void>()
      const notifyGate = vi.fn()
      const {
        useStructuredAgentItemSending,
        useStructuredAgentDisplayedSendPending,
        StructuredAgentSendingScope
      } = mobile ? mobileSending : desktopSending
      const Leaf = ({ id }: { id: string }) => {
        renders(id)
        useStructuredAgentItemSending(id)
        return null
      }
      const Gate = () => {
        const pending = useStructuredAgentDisplayedSendPending()
        return createElement('span', null, pending ? 'Sending' : 'Working')
      }
      const {
        result,
        rerender: updateSource,
        unmount
      } = renderHook(
        ({ snapshot, pending }) => {
          const desktopSource = useStructuredAgentSendingSource(
            mobile ? undefined : owner,
            pending,
            snapshot.submissions
          )
          return useMemo(
            () =>
              mobile
                ? createStructuredAgentSendingSource(
                    cache.receiptsFor('chat', snapshot.epoch, snapshot.submissions, null, {
                      current: snapshot
                    }),
                    pending,
                    snapshot.submissions
                  )
                : desktopSource,
            [desktopSource, pending, snapshot]
          )
        },
        {
          initialProps: {
            snapshot: state,
            pending: emptyPending
          }
        }
      )
      const source = result.current
      const subscribeId = source.subscribeId
      vi.spyOn(source, 'subscribeId').mockImplementation((id, listener) =>
        subscribeId(id, () => {
          notifyLeaf(id)
          listener()
        })
      )
      const gateFor = source.gateFor
      vi.spyOn(source, 'gateFor').mockImplementation((displayed) => {
        const gate = gateFor(displayed)
        const subscribe = gate.subscribe
        return {
          ...gate,
          subscribe: (listener) =>
            subscribe(() => {
              notifyGate()
              listener()
            })
        }
      })
      const view = (displayedIds: ReadonlySet<string>) =>
        createElement(
          StructuredAgentSendingScope,
          { source, displayedIds },
          createElement(Gate),
          ...ids.map((id) => createElement(Leaf, { key: id, id }))
        )
      const mounted = render(view(shown))
      const mapGet = Map.prototype.get
      const visits = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        id: unknown
      ) {
        const result = mapGet.call(this, id)
        if (typeof id === 'string' && result === `orca:${id}`) {
          countVisits.set(id, (mapGet.call(countVisits, id) ?? 0) + 1)
        }
        return result
      })
      const receiptPrototype: SubmissionReceipts = Object.getPrototypeOf(state.writtenAtById)
      const receiptReads = vi.spyOn(receiptPrototype, 'get')
      const displayChecks = vi.spyOn(shown, 'has')
      structural.mockClear()
      renders.mockClear()
      try {
        act(() => apply(batch(2, [{ ...records[0]!, writtenAt: 1800 }], [], null)))
        expect(
          [...countVisits],
          `candidate visits: ${mobile ? 'mobile' : 'desktop'} / ${size}`
        ).toEqual([['send-0', 1]])
        expect(receiptReads.mock.calls).toEqual([['send-0']])
        expect(displayChecks.mock.calls.every(([id]) => id === ids[0])).toBe(true)
        expect(displayChecks.mock.calls.length).toBeGreaterThanOrEqual(1)
        expect(displayChecks.mock.calls.length).toBeLessThanOrEqual(2)
        expect(notifyLeaf.mock.calls).toEqual([[ids[0]]])
        expect(renders.mock.calls).toEqual([[ids[0]]])
        expect(source.gateFor).toHaveBeenCalledTimes(1)
        expect(notifyGate).not.toHaveBeenCalled()
        expect(structural).not.toHaveBeenCalled()

        mounted.rerender(view(new Set([ids[0]!])))
        expect(mounted.container.textContent).toBe('Working')
        mounted.rerender(view(new Set([ids[1]!])))
        expect(mounted.container.textContent).toBe('Sending')
        act(() => apply(batch(3, [{ ...records[1]!, writtenAt: 1801 }], [], null)))
        expect(mounted.container.textContent).toBe('Working')
        expect(notifyGate).toHaveBeenCalledTimes(1)

        const newAttempt = { ...records[0]!, fence: 3, handedOverAt: 2200 }
        act(() => apply(batch(4, [newAttempt], [], null)))
        const next = mobile ? cache.get('chat')! : owner.getSnapshot().state
        const pending = steeringQueuedMessageEchoes(
          [
            {
              messageId: 'pressed-steer',
              position: 1,
              state: 'waiting',
              body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Steer' }] }
            }
          ],
          next.submissions,
          [],
          { agentWorking: true, steerIntents: new Map([['pressed-steer', 'new-attempt']]) }
        )
        updateSource({ snapshot: next, pending })
        expect(result.current).not.toBe(source)
        countVisits.clear()
        expect(result.current.gateFor(new Set(['orca:pressed-steer'])).getSnapshot()).toBe(true)
        expect(countVisits.size).toBe(size + 1)
        expect(structural).toHaveBeenCalledTimes(1)
      } finally {
        displayChecks.mockRestore()
        receiptReads.mockRestore()
        visits.mockRestore()
        mounted.unmount()
        unmount()
        unsubscribe()
        release()
        owner.dispose()
      }
    }
  }
})
