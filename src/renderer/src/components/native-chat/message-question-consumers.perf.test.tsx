// @vitest-environment happy-dom
import type * as NativeChatTransportModule from './native-chat-session-transport'
import { act, cleanup, render, screen } from '@testing-library/react'
import { memo, useLayoutEffect, useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatSessionTransport } from './native-chat-session-transport'
import type { NativeChatSubscriptionFrame } from '../../../../preload/api-types'
import { useAppStore } from '@/store'
import { useNativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { messageQuestionFixture } from '../../../../shared/message-question-occurrence.test-fixture'
import type { AgentSessionCurrentRequestsMarker } from '../../../../shared/agent-session-current-requests-wire'

import { createReadOwner } from './structured-agent-session-read-owner-create'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { MessageQuestionOccurrence } from '../../../../shared/message-question-occurrence'
import * as requestState from '../../../../shared/agent-session-current-requests'
import * as eventCoalescer from '../../../../shared/structured-agent-session-coalescer'

const structuredTransport = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: structuredTransport.call,
  subscribeStructuredAgentSession: structuredTransport.subscribe
}))

vi.mock('./native-chat-session-transport', async (original) => ({
  ...(await original<typeof NativeChatTransportModule>()),
  getNativeChatSessionTransport: (host: string) => transport(host)
}))
const initial = useAppStore.getInitialState()
const transports = new Map<string, NativeChatSessionTransport>()
const emitters = new Map<number, (frame: NativeChatSubscriptionFrame) => void>()
const renders = new Map<number, number>()
const versions = new Map<number, number>()
let reads = 0
let historyReads = 0
let opens = 0
function session(index: number): string {
  return `chat-${Math.floor(index / 2)}`
}
function marker(index: number): AgentSessionCurrentRequestsMarker {
  const revision = versions.get(index) ?? 1
  return {
    contract: 'agent-session.current-requests.v2',
    sessionId: session(index),
    epoch: 'portable-epoch',
    publisher: `host-${index % 2}`,
    revision,
    owner: `host-${index % 2}:root`,
    version: `${session(index)}-version-${revision}`
  }
}
function transport(host: string): NativeChatSessionTransport {
  let value = transports.get(host)
  if (value) {
    return value
  }
  const indexFor = (id: string) =>
    Number(id.slice('chat-'.length)) * 2 + Number(host.slice('host-'.length))
  value = {
    readSession: async () => {
      historyReads++
      return { messages: [] }
    },
    cancelCurrentQuestions: async () => {},
    subscribe: (args, emit) => {
      opens++
      const index = indexFor(args.sessionId)
      emitters.set(index, emit)
      emit({ type: 'snapshot', messages: [], hasMore: false })
      return () => {
        emitters.delete(index)
      }
    },
    currentRequests: async (request) => {
      reads++
      const index = indexFor(request.sessionId)
      return {
        marker: marker(index),
        nextCursor: null,
        json: JSON.stringify({
          blocking: [],
          asyncQuestions:
            versions.get(index) === 2 ? null : [messageQuestionFixture('equal-portable-question')],
          context: { sessionId: session(index), boundary: 'root' }
        })
      }
    }
  }
  transports.set(host, value)
  return value
}
function Consumer({ index }: { index: number }) {
  const live = useNativeChatLiveSession({
    paneKey: `pane-${index}`,
    agent: 'codex',
    sessionId: session(index),
    transcriptPath: `/portable/${session(index)}`,
    runtimeEnvironmentId: `host-${index % 2}`
  })
  const card = useNativeChatInteractivePromptCard({
    paneKey: `pane-${index}`,
    asyncQuestion: live.asyncQuestion,
    messages: live.messages,
    transcriptSettled: true
  })
  useLayoutEffect(() => {
    renders.set(index, (renders.get(index) ?? 0) + 1)
  })
  return (
    <output data-testid={`chat-${index}`}>
      {card?.kind === 'question'
        ? `${card.prompt.questions[0].question}:${live.messageQuestions?.ready ? 'ready' : 'loading'}`
        : 'empty'}
    </output>
  )
}
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  emitters.clear()
  transports.clear()
  versions.clear()
  renders.clear()
  useAppStore.setState(initial, true)
})
it.each([10, 100])(
  'isolates real live-hook source/read work and commits across %i chats with equal portable IDs on different hosts',
  async (count) => {
    for (let index = 0; index < count; index++) {
      useAppStore
        .getState()
        .setAgentStatus(`pane-${index}`, { agentType: 'codex', state: 'working', prompt: '' })
    }
    render(
      <>
        {Array.from({ length: count }, (_, index) => (
          <Consumer key={index} index={index} />
        ))}
      </>
    )
    await act(async () => {})
    expect(emitters.size).toBe(count)
    reads = historyReads = opens = 0
    renders.clear()
    await act(async () => {
      useAppStore.getState().setAgentStatus('unrelated-pane', {
        agentType: 'codex',
        state: 'working',
        prompt: 'new unrelated chat'
      })
    })
    expect([...renders]).toEqual([])
    expect({ reads, historyReads, opens }).toEqual({ reads: 0, historyReads: 0, opens: 0 })
    for (let tick = 0; tick < 50; tick++) {
      await act(async () => {
        useAppStore.getState().setAgentStatus(tick % 2 === 0 ? 'unrelated-pane' : 'pane-0', {
          agentType: 'codex',
          state: 'working',
          prompt: `unused-other-host-${tick}`
        })
      })
    }
    expect({ reads, historyReads, opens }).toEqual({ reads: 0, historyReads: 0, opens: 0 })
    expect([...renders]).toEqual([])
    const publish = async (revision: number) => {
      versions.set(0, revision)
      await act(async () =>
        emitters.get(0)?.({ type: 'appended', messages: [], currentRequests: marker(0) })
      )
      expect([...renders.keys()]).toEqual([0])
      expect(screen.getByTestId('chat-1').textContent).toBe('empty')
      expect(historyReads).toBe(0)
      expect(opens).toBe(0)
    }
    await publish(1)
    expect(reads).toBe(1)
    expect(screen.getByTestId('chat-0').textContent).toBe('Which color?:ready')
    await publish(2)
    expect(reads).toBe(2)
    expect(screen.getByTestId('chat-0').textContent).toBe('Which color?:loading')
    renders.clear()
    for (let tick = 0; tick < 50; tick++) {
      await act(async () => {
        emitters.get(0)?.({ type: 'appended', messages: [], currentRequests: marker(0) })
      })
    }
    expect(reads).toBe(2)
    expect([...renders]).toEqual([])
    await publish(3)
    expect(reads).toBe(3)
    expect(screen.getByTestId('chat-0').textContent).toBe('Which color?:ready')
    renders.clear()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
    await act(async () =>
      useAppStore.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
    )
    clock.mockRestore()
    expect([...renders.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, index) => index)
    )
    expect({ reads, historyReads, opens }).toEqual({ reads: 3, historyReads: 0, opens: 0 })
  }
)

it.each([10, 100])(
  'keeps actual structured read owners and request cards quiet across %i mounted chats until their own history or requests change',
  async (count) => {
    const events = new Map<number, (event: AgentSessionSubscribeEvent) => void>()
    const notifications = new Map<number, number>()
    const commits = new Map<number, number>()
    const cardCommits = new Map<number, number>()
    const selections = new Map<number, number>()
    const revisions = new Map<number, number>()
    const increment = (map: Map<number, number>, index: number) =>
      map.set(index, (map.get(index) ?? 0) + 1)
    const claim = (index: number): AgentSessionCurrentRequestsMarker => ({
      contract: 'agent-session.current-requests.v2',
      sessionId: session(index),
      epoch: 'structured-epoch',
      publisher: `host-${index % 2}`,
      revision: revisions.get(index) ?? 1,
      owner: `host-${index % 2}:structured`,
      version: `structured-${index}-${revisions.get(index) ?? 1}`
    })
    const item = (id: string, sequence: number): AgentJournalRenderItem => ({
      itemId: id,
      revision: 1,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
    })
    const page = (index: number, sequence = 1): AgentSessionHistoryPage => ({
      sessionId: session(index),
      epoch: 'structured-epoch',
      direction: 'tail',
      items: [item(`history-${index}-${sequence}`, sequence)],
      submissions: [],
      removedItemIds: [],
      window: { oldest: null, newest: null, nextCursor: { epoch: 'structured-epoch', sequence } },
      hasOlder: false,
      hasNewer: false
    })
    const indexFor = (target: { environmentId: string }, params: { sessionId: string }) =>
      Number(params.sessionId.slice('chat-'.length)) * 2 +
      Number(target.environmentId.slice('host-'.length))
    let definitionEncodes = 0
    structuredTransport.call.mockImplementation(async (target, method, params) => {
      const index = indexFor(target, params)
      if (method === 'agentSession.history') {
        return { ok: true, page: page(index) }
      }
      if (method !== 'agentSession.currentRequests') {
        throw new Error(`Unexpected read: ${method}`)
      }
      definitionEncodes++
      return {
        marker: claim(index),
        nextCursor: null,
        json: JSON.stringify({
          blocking: [],
          asyncQuestions: [
            messageQuestionFixture(`structured-${index}-${revisions.get(index) ?? 1}`)
          ],
          context: { sessionId: session(index), boundary: 'root' }
        })
      }
    })
    const releases = vi.fn()
    structuredTransport.subscribe.mockImplementation(async (target, params, emit) => {
      const index = indexFor(target, params)
      events.set(index, emit)
      emit({
        type: 'snapshot',
        sessionId: session(index),
        fence: 1,
        page: page(index),
        currentRequests: claim(index)
      })
      return {
        unsubscribe: () => {
          releases(index)
          events.delete(index)
        }
      }
    })
    replaceRuntimeEnvironmentRevisions([
      { id: 'host-0', createdAt: 1 },
      { id: 'host-1', createdAt: 1 }
    ])
    let dispatches = 0
    const originalCoalescer = eventCoalescer.createStructuredAgentSessionEventCoalescer
    vi.spyOn(eventCoalescer, 'createStructuredAgentSessionEventCoalescer').mockImplementation(
      (emit, delay) =>
        originalCoalescer((event) => {
          dispatches++
          emit(event)
        }, delay)
    )
    const projections = vi.spyOn(requestState, 'currentRequestsState')
    const owners = Array.from({ length: count }, (_, index) =>
      createReadOwner(`h5-owner-${index}`, session(index), {
        kind: 'environment',
        environmentId: `host-${index % 2}`
      })
    )
    const stops: (() => void)[] = []
    const Card = memo(function Card({
      index,
      records,
      ready
    }: {
      index: number
      records: readonly MessageQuestionOccurrence[]
      ready: boolean
    }) {
      useLayoutEffect(() => {
        increment(cardCommits, index)
      })
      return (
        <span>
          {records[0]?.id}:{String(ready)}
        </span>
      )
    })
    function StructuredConsumer({ index }: { index: number }) {
      const owner = owners[index]
      const { state } = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
      increment(selections, index)
      const view = requestState.currentMessageQuestionView(state)
      useLayoutEffect(() => {
        increment(commits, index)
      })
      return (
        <output data-testid={`structured-${index}`}>
          {state.items.map((row) => row.itemId).join(',')}
          {view && <Card index={index} records={view.records} ready={view.ready} />}
        </output>
      )
    }
    try {
      render(
        <>
          {owners.map((_, index) => (
            <StructuredConsumer key={index} index={index} />
          ))}
        </>
      )
      await act(async () => {
        owners.forEach((owner, index) => {
          stops.push(
            owner.subscribe(() => {
              increment(notifications, index)
            })
          )
          stops.push(
            owner.activate({ getState: useAppStore.getState, subscribeRetryNow: () => () => {} })
          )
        })
      })
      await vi.waitFor(() =>
        expect(
          owners.every(
            (owner) => requestState.currentMessageQuestionView(owner.getSnapshot().state)?.ready
          )
        ).toBe(true)
      )
      expect(events.size).toBe(count)
      const baseline = {
        calls: structuredTransport.call.mock.calls.length,
        opens: structuredTransport.subscribe.mock.calls.length,
        definitionEncodes
      }
      commits.clear()
      cardCommits.clear()
      notifications.clear()
      selections.clear()
      projections.mockClear()
      dispatches = 0
      vi.useFakeTimers()
      for (let tick = 0; tick < 50; tick++) {
        await act(async () => {
          useAppStore.getState().setAgentStatus(`unused-structured-${tick}`, {
            agentType: 'codex',
            state: 'working',
            prompt: String(tick)
          })
          events.forEach((emit, index) =>
            emit({
              type: 'batch',
              sessionId: session(index),
              currentRequests: claim(index),
              batch: {
                cursor: { epoch: 'structured-epoch', sequence: 1 },
                items: [],
                removedItemIds: [],
                submissions: []
              }
            })
          )
          await vi.advanceTimersByTimeAsync(48)
        })
      }
      expect({
        calls: structuredTransport.call.mock.calls.length,
        opens: structuredTransport.subscribe.mock.calls.length,
        definitionEncodes
      }).toEqual(baseline)
      expect(dispatches).toBe(50 * count)
      expect(projections).not.toHaveBeenCalled()
      expect([...notifications]).toEqual([])
      expect([...selections]).toEqual([])
      expect([...commits]).toEqual([])
      expect([...cardCommits]).toEqual([])
      await act(async () => {
        events.get(0)!({
          type: 'batch',
          sessionId: session(0),
          currentRequests: claim(0),
          batch: {
            cursor: { epoch: 'structured-epoch', sequence: 2 },
            items: [item('actual-own-output', 2)],
            removedItemIds: [],
            submissions: []
          }
        })
        await vi.advanceTimersByTimeAsync(47)
        expect([...notifications]).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
      })
      expect([...commits.keys()]).toEqual([0])
      expect([...notifications.keys()]).toEqual([0])
      expect([...cardCommits]).toEqual([])
      expect(screen.getByTestId('structured-0').textContent).toContain('actual-own-output')
      expect(projections).toHaveBeenCalledTimes(1)
      commits.clear()
      notifications.clear()
      projections.mockClear()
      await act(async () =>
        events.get(0)!({
          type: 'reset',
          reset: 'epoch_changed',
          sessionId: session(0),
          fence: 2,
          page: page(0, 3),
          currentRequests: claim(0)
        })
      )
      expect(owners[0].getSnapshot().state.items[0].itemId).toBe('history-0-3')
      expect([...commits.keys()]).toEqual([0])
      expect([...cardCommits]).toEqual([])
      expect(projections).toHaveBeenCalledTimes(1)
      commits.clear()
      notifications.clear()
      projections.mockClear()
      revisions.set(0, 2)
      await act(async () => {
        events.get(0)!({
          type: 'batch',
          sessionId: session(0),
          currentRequests: claim(0),
          batch: {
            cursor: { epoch: 'structured-epoch', sequence: 3 },
            items: [],
            removedItemIds: [],
            submissions: []
          }
        })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect([...commits.keys()]).toEqual([0])
      expect([...cardCommits.keys()]).toEqual([0])
      expect(structuredTransport.call.mock.calls.length).toBe(baseline.calls + 1)
      expect(definitionEncodes).toBe(baseline.definitionEncodes + 1)
      expect(screen.getByTestId('structured-1').textContent).toContain('history-1-1')
      console.log('structured-desktop-ownership-counts', {
        count,
        duplicateDispatches: 50 * count,
        duplicateNotifications: 0,
        duplicateCommits: 0,
        duplicateUpstreamCalls: 0,
        actualOwnRequestCalls: 1,
        definitionsEncoded: definitionEncodes,
        totalDispatches: dispatches
      })
    } finally {
      cleanup()
      stops.toReversed().forEach((stop) => stop())
      owners.forEach((owner) => owner.dispose())
      await Promise.resolve()
      vi.useRealTimers()
      replaceRuntimeEnvironmentRevisions([])
      expect(releases).toHaveBeenCalledTimes(count)
    }
  }
)
