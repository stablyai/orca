// @vitest-environment happy-dom
import {
  fixture,
  transport,
  WORKSPACE,
  TARGET,
  SCOPE,
  ReadSurface
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../src/shared/agent-session-wire'
import { agentJournalSubmissionKey } from '../../src/shared/agent-session-journal-item-key'
import { agentSessionPromptAttentionKey } from '../../src/shared/agent-session-attention'
import { STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS } from '../../src/shared/structured-agent-session-coalescer'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'

it.each([
  [512, 128, 2, 2],
  [5120, 128, 2, 2],
  [512, 128, 20, 2],
  [512, 128, 2, 20],
  [5120, 1280, 2, 2]
])(
  'bounds live held-reader publication at L=%i S=%i q=%i T=%i',
  async (length, submissions, owed, tabs) => {
    const items: AgentJournalRenderItem[] = Array.from({ length }, (_, index) => ({
      itemId: `history-${index}`,
      revision: 1,
      sequence: index + 1,
      observedAt: index + 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] }
    }))
    items[9]!.body = {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 10 }
    }
    const retained: AgentJournalSubmission[] = Array.from({ length: submissions }, (_, index) => {
      const item = items[index + 20]!
      item.itemId = agentJournalSubmissionKey(`sent-${index}`)
      item.body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Request' }] }
      return {
        clientMessageId: `sent-${index}`,
        fence: 1,
        payloadFingerprint: '0'.repeat(64),
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: index + 1,
        resolvedAt: index + 1,
        acceptedSequence: item.sequence
      }
    })
    items[length - 5]!.body = {
      kind: 'turn',
      turnId: 'settled',
      state: 'completed',
      outcome: 'success',
      userItemId: items[20]!.itemId
    }
    items[length - 4]!.body = {
      kind: 'message',
      role: 'user',
      command: { name: 'compact' },
      blocks: []
    }
    items[length - 3]!.body = {
      kind: 'turn',
      turnId: 'command',
      state: 'running',
      userItemId: items[length - 4]!.itemId
    }
    const page = (
      start: number,
      end: number,
      direction: 'tail' | 'before'
    ): AgentSessionHistoryPage => {
      const loaded = items.slice(start, end)
      const ids = new Set(loaded.map((item) => item.itemId))
      return {
        sessionId: SESSION,
        epoch: 'journal-a',
        direction,
        items: loaded,
        removedItemIds: [],
        submissions: retained.filter((submission) =>
          ids.has(agentJournalSubmissionKey(submission.clientMessageId))
        ),
        window: {
          oldest: { epoch: 'journal-a', sequence: start + 1 },
          newest: { epoch: 'journal-a', sequence: end },
          nextCursor: { epoch: 'journal-a', sequence: start + 1 }
        },
        liveCursor: { epoch: 'journal-a', sequence: length },
        hasOlder: start > 0,
        hasNewer: direction === 'before'
      }
    }
    transport.call.mockImplementation(
      async (_target, method, params: { direction: string; cursor?: { sequence: number } }) => {
        if (method !== 'agentSession.history') {
          throw new Error(`Unexpected call: ${method}`)
        }
        const end = params.direction === 'tail' ? length : params.cursor!.sequence - 1
        return {
          ok: true,
          page: page(Math.max(0, end - 300), end, params.direction === 'tail' ? 'tail' : 'before')
        }
      }
    )
    useAppStore.setState({
      activeWorktreeId: 'elsewhere',
      unifiedTabsByWorktree: {
        [WORKSPACE]: Array.from({ length: tabs }, (_, index) =>
          makeUnifiedTab({
            id: `scale-${index}`,
            worktreeId: WORKSPACE,
            groupId: 'group',
            contentType: 'agent-session',
            entityId: index === tabs - 1 ? 'nonmatching' : SESSION,
            agentSessionAgent: 'claude'
          })
        )
      }
    })
    Object.assign(window.api, { worktrees: { updateMeta: vi.fn().mockResolvedValue(undefined) } })
    const subscriptionsOpened = vi.spyOn(window.api.runtime, 'subscribe')
    const owner = getStructuredAgentSessionReadOwner(SESSION, TARGET)
    const observe = {
      callbacks: 0,
      bridgeCallbacks: 0,
      elements: 0,
      derivedCopies: 0,
      mapEntries: 0,
      mapLookups: 0,
      mapWrites: 0
    }
    let measuring = false
    const snapshot = owner.getSnapshot
    const subscribe = owner.subscribe
    // Test-only attribution depends on source-mapped stacks; a missing match fails the positive controls.
    const subscribeSpy = vi.spyOn(owner, 'subscribe').mockImplementation((listener) => {
      const bridge =
        new Error('Trace held-reader listener origin').stack
          ?.replaceAll('\\', '/')
          .includes('/StructuredAgentSessionAttentionBridge.tsx:') ?? false
      return subscribe(() => {
        observe.callbacks += 1
        if (bridge) {
          observe.bridgeCallbacks += 1
        }
        measuring = bridge
        try {
          listener()
        } finally {
          measuring = false
        }
      })
    })
    const wrap = <T extends readonly unknown[]>(values: T): T =>
      new Proxy(values, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            observe.elements += 1
          }
          const value =
            typeof key === 'string' && /^\d+$/.test(key)
              ? target[Number(key)]
              : key === 'length'
                ? target.length
                : Object.getOwnPropertyDescriptor(Array.prototype, key)?.value
          if (Array.isArray(value)) {
            return wrap(value)
          }
          if (typeof value !== 'function' || key === 'constructor') {
            return value
          }
          return (...args: unknown[]) => {
            const result = value.apply(receiver, args)
            if (Array.isArray(result)) {
              observe.derivedCopies += result.length
              return wrap(result)
            }
            return result
          }
        }
      })
    const snapshotSpy = vi.spyOn(owner, 'getSnapshot').mockImplementation(() => {
      const current = snapshot()
      return measuring
        ? {
            ...current,
            state: {
              ...current.state,
              items: wrap(current.state.items),
              submissions: wrap(current.state.submissions)
            }
          }
        : current
    })
    const entries = Map.prototype[Symbol.iterator]
    const get = Map.prototype.get
    const set = Map.prototype.set
    const entryDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)!
    const getDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!
    const setDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, 'set')!
    Object.defineProperty(Map.prototype, Symbol.iterator, {
      ...entryDescriptor,
      value: function* (this: Map<unknown, unknown>): MapIterator<[unknown, unknown]> {
        for (const entry of entries.call(this)) {
          if (measuring) {
            observe.mapEntries += 1
          }
          yield entry
        }
      }
    })
    Object.defineProperty(Map.prototype, 'get', {
      ...getDescriptor,
      value: function (this: Map<unknown, unknown>, key: unknown) {
        if (measuring) {
          observe.mapLookups += 1
        }
        return get.call(this, key)
      }
    })
    Object.defineProperty(Map.prototype, 'set', {
      ...setDescriptor,
      value: function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (measuring) {
          observe.mapWrites += 1
        }
        return set.call(this, key, value)
      }
    })
    const feed = getStructuredAgentSessionTurnCompletionFeed(TARGET)
    let edgeVisits = 0
    const edges = feed.subscribe.bind(feed)
    const edgeSpy = vi.spyOn(feed, 'subscribe').mockImplementation((listener) =>
      edges((edge) => {
        edgeVisits += 1
        listener(edge)
      })
    )
    const clearCounts = () => {
      for (const key of Object.keys(observe)) {
        Object.defineProperty(observe, key, {
          value: 0,
          writable: true,
          enumerable: true,
          configurable: true
        })
      }
    }
    const work = () =>
      observe.elements +
      observe.derivedCopies +
      observe.mapEntries +
      observe.mapLookups +
      observe.mapWrites
    // Per affected listener/publication: context/copies <=3L+2S; selector/joins/Map tuples <=14L+4S; owed <=2q.
    // 64(L+S+q+8) includes derived-array indexed reads, copies and synchronous notification plumbing.
    const perListenerBound = 64 * (length + submissions + owed + 8)
    let screen: ReturnType<typeof render> | undefined
    const publish = async (changed: AgentJournalRenderItem[], sequence: number) => {
      if (!fixture.journal) {
        throw new Error('No live history transport')
      }
      const emit = fixture.journal
      await act(async () => {
        emit({
          id: 'journal',
          ok: true,
          _meta: { runtimeId: 'attention-host' },
          result: {
            type: 'batch',
            sessionId: SESSION,
            batch: {
              cursor: { epoch: 'journal-a', sequence },
              items: changed,
              removedItemIds: [],
              submissions: []
            }
          }
        })
        await new Promise((resolve) =>
          setTimeout(resolve, STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS + 1)
        )
      })
    }
    try {
      screen = render(
        createElement(
          Fragment,
          null,
          createElement(ReadSurface, { viewed: false }),
          createElement(StructuredAgentSessionAttentionBridge)
        )
      )
      await waitFor(() => expect(fixture.journal).toBeTypeOf('function'))
      while (owner.getSnapshot().state.hasOlder) {
        await act(async () => {
          expect(await owner.loadOlder()).toBe('applied')
        })
      }
      await publish([], length)
      expect(owner.getSnapshot().current).toBe(true)
      expect(owner.getSnapshot().state.items).toHaveLength(length)
      expect(owner.getSnapshot().state.items[0]?.itemId).toBe('history-0')
      expect(owner.getSnapshot().state.submissions).toHaveLength(submissions)
      expect(
        transport.call.mock.calls.filter(([, method]) => method === 'agentSession.history').length
      ).toBeGreaterThan(1)
      await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
      clearCounts()
      await publish([{ ...items[length - 1]!, revision: 2 }], length + 1)
      expect(observe.bridgeCallbacks).toBeGreaterThan(0)
      expect(work()).toBe(0)
      const emptyOwed = { ...observe }
      const emitEdge = fixture.completion!
      const beforeEdges = edgeVisits
      act(() => {
        for (let index = 0; index < owed; index += 1) {
          emitEdge({
            id: 'completion',
            ok: true,
            _meta: { runtimeId: 'attention-host' },
            result: {
              type: 'prompt',
              prompt: {
                scope: SCOPE,
                sessionId: SESSION,
                promptId: `owed-${index}`,
                raisedAt: index + 1,
                journalCursor: { epoch: 'journal-a', sequence: length + 1 }
              }
            }
          })
        }
      })
      const fanout = edgeVisits - beforeEdges
      expect(fanout).toBeGreaterThanOrEqual((tabs - 1) * owed)
      expect(fanout).toBeLessThanOrEqual(4 * tabs * owed)
      transport.dismiss.mockClear()
      clearCounts()
      for (let revision = 3; revision <= 4; revision += 1) {
        await publish([{ ...items[length - 1]!, revision }], length + revision)
        expect(owner.getSnapshot().state.items.at(-1)?.revision).toBe(revision)
        expect(owner.getSnapshot().state.items).toHaveLength(length)
        expect(owner.getSnapshot().state.submissions).toHaveLength(submissions)
      }
      const revisions = { ...observe }
      expect(revisions.bridgeCallbacks).toBeGreaterThanOrEqual(2 * (tabs - 1))
      expect(revisions.bridgeCallbacks).toBeLessThanOrEqual(4 * (tabs - 1))
      expect(revisions.elements).toBeGreaterThanOrEqual(2 * (tabs - 1) * (length + submissions))
      expect(revisions.derivedCopies).toBeGreaterThanOrEqual(2 * (tabs - 1) * (length - 10))
      expect(revisions.mapWrites).toBeGreaterThanOrEqual(2 * (tabs - 1) * (length - 10))
      expect(revisions.mapEntries).toBeGreaterThanOrEqual(2 * (tabs - 1) * owed)
      expect(work()).toBeLessThanOrEqual(perListenerBound * revisions.bridgeCallbacks)
      expect(transport.dismiss).not.toHaveBeenCalled()
      clearCounts()
      await publish(
        [
          {
            itemId: 'later-user',
            revision: 1,
            sequence: length + 9,
            observedAt: length + 9,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Next request' }]
            }
          },
          {
            itemId: 'later-root',
            revision: 1,
            sequence: length + 10,
            observedAt: length + 10,
            body: { kind: 'turn', turnId: 'later', state: 'running', userItemId: 'later-user' }
          }
        ],
        length + 10
      )
      const later = { ...observe }
      const laterLength = owner.getSnapshot().state.items.length
      expect(laterLength).toBeGreaterThanOrEqual(length)
      expect(laterLength).toBeLessThanOrEqual(length + 2)
      expect(
        owner.getSnapshot().state.items.find((item) => item.itemId === 'later-user')?.body
      ).toMatchObject({ role: 'user' })
      expect(
        owner.getSnapshot().state.items.find((item) => item.itemId === 'later-root')?.body
      ).toMatchObject({ state: 'running', userItemId: 'later-user' })
      expect(owner.getSnapshot().state.submissions).toHaveLength(submissions)
      expect(later.bridgeCallbacks).toBeGreaterThanOrEqual(tabs - 1)
      expect(later.bridgeCallbacks).toBeLessThanOrEqual(2 * (tabs - 1))
      expect(later.elements).toBeGreaterThan(0)
      expect(later.mapEntries).toBeGreaterThanOrEqual(2 * owed * (tabs - 1))
      expect(work()).toBeLessThanOrEqual(perListenerBound * later.bridgeCallbacks)
      const expected = Array.from({ length: owed }, (_, index) => ({
        notificationId: agentSessionPromptAttentionKey(SCOPE, SESSION, `owed-${index}`)
      }))
      expect(transport.dismiss).toHaveBeenCalledTimes(tabs - 1)
      for (const call of transport.dismiss.mock.calls) {
        expect(call[3]).toEqual(expected)
      }
      expect(
        subscriptionsOpened.mock.calls.filter(
          ([request]) => request.method === 'agentSession.subscribeTurnCompletions'
        )
      ).toHaveLength(1)
      screen.unmount()
      const after = {
        callbacks: observe.callbacks,
        edgeVisits,
        dismisses: transport.dismiss.mock.calls.length
      }
      await publish([], length + 20)
      act(() =>
        emitEdge({
          id: 'completion',
          ok: true,
          _meta: { runtimeId: 'attention-host' },
          result: {
            type: 'prompt',
            prompt: {
              scope: SCOPE,
              sessionId: SESSION,
              promptId: 'after-cleanup',
              raisedAt: 100,
              journalCursor: { epoch: 'journal-a', sequence: length + 20 }
            }
          }
        })
      )
      expect(observe.callbacks).toBe(after.callbacks)
      expect(edgeVisits).toBe(after.edgeVisits)
      expect(transport.dismiss).toHaveBeenCalledTimes(after.dismisses)
      console.info('renderer-scaling', {
        length,
        submissions,
        owed,
        tabs,
        perListenerBound,
        laterLength,
        emptyOwed,
        revisions,
        later,
        fanout
      })
    } finally {
      screen?.unmount()
      measuring = false
      Object.defineProperty(Map.prototype, Symbol.iterator, entryDescriptor)
      Object.defineProperty(Map.prototype, 'get', getDescriptor)
      Object.defineProperty(Map.prototype, 'set', setDescriptor)
      snapshotSpy.mockRestore()
      subscribeSpy.mockRestore()
      edgeSpy.mockRestore()
      subscriptionsOpened.mockRestore()
    }
  }
)
