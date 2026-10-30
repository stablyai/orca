import type {
  CurrentRequestsPayload,
  AgentSessionCurrentRequestsRead
} from './agent-session-current-requests-wire'
import type { AgentSessionCurrentRequestsState } from './agent-session-current-requests'
import { expect, it, vi } from 'vitest'
import {
  applyCurrentRequestsMarker,
  hasCompleteBlockingRequests,
  currentMessageQuestionView
} from './agent-session-current-requests'
import { messageQuestionFixture } from './message-question-occurrence.test-fixture'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS
} from './structured-agent-session-item-retention'
import type { StructuredAgentSessionState } from './structured-agent-session-reducer'
import type { AgentSessionHistoryPage, AgentSessionSubscribeEvent } from './agent-session-wire'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'

const marker: AgentSessionCurrentRequestsMarker = {
  contract: 'agent-session.current-requests.v2',
  sessionId: 'chat',
  epoch: 'journal-epoch',
  publisher: 'publisher-one',
  revision: 1,
  owner: 'publisher-one:canonical-source',
  version: 'one'
}

it('installs only a matching complete publication, retaining disabled same-source records during replacement', () => {
  const records = [messageQuestionFixture('host-address')]
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'requests-marker',
    marker
  })
  expect(state.asyncQuestions).toBeUndefined()
  expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: false })
  const payload = {
    blocking: [],
    asyncQuestions: records,
    context: { sessionId: 'chat', boundary: 'root' }
  }
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker,
    items: [],
    payload
  })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: true })
  const replacement = {
    ...marker,
    publisher: 'publisher-two',
    owner: 'publisher-two:canonical-source',
    version: 'two'
  }
  state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker: replacement })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: false })
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker,
    items: [],
    payload: { ...payload, asyncQuestions: [] }
  })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: false })
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker: replacement,
    items: [],
    payload: { ...payload, asyncQuestions: [] }
  })
  expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: true })
})

it('cannot retain controls from a different session', () => {
  const field = 'sessionId'
  const records = [messageQuestionFixture('other-source-question')]
  const state = { asyncQuestions: records, requestMarker: marker, requestAuthority: marker }
  const other = {
    ...marker,
    publisher: 'new-publisher',
    owner: 'new-publisher:canonical-source',
    version: 'two',
    [field]: 'different'
  }
  const next = applyCurrentRequestsMarker(state, other)
  expect(next.asyncQuestions).toBeUndefined()
  expect(next.requestAuthority).toBeUndefined()
  expect(currentMessageQuestionView(next)).toEqual({ records: [], ready: false })
})

it.each(['owner', 'epoch'] as const)(
  'retains same-resource controls disabled across a physical %s change until context is verified',
  (field) => {
    const records = [messageQuestionFixture('durable-question')]
    const next = applyCurrentRequestsMarker(
      { asyncQuestions: records, requestMarker: marker, requestAuthority: marker },
      { ...marker, [field]: 'publisher-one:replacement', revision: 2, version: 'two' }
    )
    expect(currentMessageQuestionView(next)).toEqual({ records, ready: false })
    expect(next.requestMarker?.version).toBe('two')
    expect(currentMessageQuestionView(next)?.ready).toBe(false)
  }
)

it('uses the same atomic null/context/array completion on structured and terminal readers with stable duplicate installs', async () => {
  const { createAgentSessionCurrentRequestsReader } =
    await import('./agent-session-current-requests-reader')
  const { createNativeChatCurrentRequestsBinding } =
    await import('./native-chat-current-requests-binding')
  const { hasCompleteBlockingRequests } = await import('./agent-session-current-requests')
  const records = [messageQuestionFixture('retained')]
  const prompt: AgentJournalRenderItem = {
    itemId: 'full-control',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'approval',
      title: 'Allow a real command?',
      detail: 'git status',
      options: [{ id: 'yes', label: 'Allow once' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  let currentMarker = marker
  let payload: CurrentRequestsPayload = {
    blocking: [prompt],
    asyncQuestions: records,
    context: { sessionId: 'chat', boundary: 'root' }
  }
  const read = async (request: AgentSessionCurrentRequestsRead) => {
    const json = JSON.stringify(payload)
    const split = Math.floor(json.length / 2)
    return {
      marker: currentMarker,
      json: request.cursor ? json.slice(split) : json.slice(0, split),
      nextCursor: request.cursor ? null : split
    }
  }
  let structured = EMPTY_STRUCTURED_AGENT_SESSION
  let terminal: AgentSessionCurrentRequestsState = {}
  let terminalCommits = 0
  const reader = createAgentSessionCurrentRequestsReader({
    read,
    replaceMarker: (next) => {
      structured = reduceStructuredAgentSession(structured, {
        type: 'requests-marker',
        marker: next
      })
    },
    complete: (next, items, complete) => {
      structured = reduceStructuredAgentSession(structured, {
        type: 'requests-complete',
        marker: next,
        items,
        payload: complete
      })
    },
    error: (error) => {
      throw error
    }
  })
  const binding = createNativeChatCurrentRequestsBinding({
    read,
    publish: (state) => {
      terminal = state
      terminalCommits++
    }
  })
  const observe = () => {
    structured = reduceStructuredAgentSession(structured, {
      type: 'requests-marker',
      marker: currentMarker
    })
    reader.observe(currentMarker)
    binding.observe({ type: 'appended', currentRequests: currentMarker })
  }
  try {
    observe()
    await vi.waitFor(() =>
      expect([structured, terminal].every(hasCompleteBlockingRequests)).toBe(true)
    )
    const kept = [structured.asyncQuestions, terminal.asyncQuestions]
    currentMarker = { ...marker, revision: 2, version: 'unknown' }
    payload = { ...payload, asyncQuestions: null }
    observe()
    await vi.waitFor(() =>
      expect([structured, terminal].every(hasCompleteBlockingRequests)).toBe(true)
    )
    for (const [index, state] of [structured, terminal].entries()) {
      expect(currentMessageQuestionView(state)).toEqual({ records, ready: false })
      expect(state.asyncQuestions).toBe(kept[index])
      expect(state.currentRequests?.[0].body).toEqual(prompt.body)
    }
    const same = structured
    const before = terminalCommits
    observe()
    await Promise.resolve()
    expect(structured).toBe(same)
    expect(terminalCommits).toBe(before)
    currentMarker = { ...marker, revision: 3, version: 'different-context' }
    payload = { ...payload, context: { sessionId: 'chat', boundary: 'clear-operation' } }
    observe()
    await vi.waitFor(() =>
      expect([structured, terminal].every(hasCompleteBlockingRequests)).toBe(true)
    )
    for (const state of [structured, terminal]) {
      expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: false })
    }
    currentMarker = { ...marker, revision: 4, version: 'complete-empty' }
    payload = { ...payload, asyncQuestions: [] }
    observe()
    await vi.waitFor(() =>
      expect(
        [structured, terminal].every((state) => currentMessageQuestionView(state)?.ready)
      ).toBe(true)
    )
    for (const state of [structured, terminal]) {
      expect(currentMessageQuestionView(state)?.records).toEqual([])
    }
  } finally {
    reader.invalidate()
    binding.invalidate()
  }
})

it('installs fresh history independently of request no-ops through the real coalescer and reducer', () => {
  const output = (id: string, sequence: number): AgentJournalRenderItem => ({
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  })
  const records = [messageQuestionFixture('retained-across-page')]
  const context = { sessionId: 'chat', boundary: 'root' }
  const installed = reduceStructuredAgentSession(
    reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'requests-marker',
      marker
    }),
    {
      type: 'requests-complete',
      marker,
      items: [],
      payload: { blocking: [], asyncQuestions: records, context }
    }
  )
  // This reaches the existing defensive reducer branch, not nominal wire admission.
  const unsupported = Object.defineProperty({ ...marker }, 'contract', { value: 'future.contract' })
  const variants = [
    { name: 'equal', claim: marker },
    { name: 'older', claim: { ...marker, revision: 0, version: 'older' } },
    { name: 'unsupported', claim: unsupported },
    { name: 'new', claim: { ...marker, revision: 2, version: 'new' } },
    {
      name: 'different-resource',
      claim: { ...marker, revision: 2, version: 'other', sessionId: 'other' }
    },
    { name: 'established-markerless', claim: undefined },
    { name: 'initial-legacy', claim: undefined }
  ]
  for (const type of ['snapshot', 'reset'] as const) {
    for (const variant of variants) {
      const oldItem = output('obsolete-page-output', 5)
      let state: StructuredAgentSessionState = {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        ...(variant.name === 'initial-legacy' ? {} : installed),
        epoch: 'obsolete-epoch',
        cursor: { epoch: 'obsolete-epoch', sequence: 5 },
        fence: 1,
        items: [oldItem],
        submissions: [],
        retainedOwnItemLimit: 9999,
        retainedItemCap: 19999,
        hasOlder: true,
        status: 'error',
        error: 'old failure',
        readRefusal: { code: 'agent_session_ownership_unknown' },
        working: true,
        latestTurn: null,
        actionablePromptIds: ['obsolete-prompt'],
        backgroundTasks: { state: 'monitoring', tasks: [{ id: 'old-task', kind: 'agent' }] },
        activity: { turnId: 'old-turn', text: 'old activity' },
        unloadedTurnRevisions: 8,
        subagentRoster: new Map([
          [
            'old-child',
            {
              entry: { id: 'old-child', label: 'Old', state: 'completed' },
              rosterItemId: 'old-roster',
              rosterPosition: { sequence: 1, index: 0 },
              rosterRevision: 1
            }
          ]
        ])
      }
      const previous = state
      const fresh = output(`fresh-${type}-${variant.name}`, 100)
      const page: AgentSessionHistoryPage = {
        sessionId: 'chat',
        epoch: 'fresh-epoch',
        direction: 'tail',
        items: [fresh],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'fresh-epoch', sequence: 100 },
          newest: { epoch: 'fresh-epoch', sequence: 100 },
          nextCursor: { epoch: 'fresh-epoch', sequence: 99 }
        },
        liveCursor: { epoch: 'fresh-epoch', sequence: 101 },
        hasOlder: false,
        hasNewer: false
      }
      let dispatches = 0
      const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
        dispatches++
        state = reduceStructuredAgentSession(state, { type: 'event', event }, 200)
      })
      try {
        // Replacement must flush buffered output and then install its own page.
        coalescer.push({
          type: 'batch',
          sessionId: 'chat',
          batch: {
            cursor: { epoch: 'obsolete-epoch', sequence: 6 },
            items: [output('buffered-old-output', 6)],
            removedItemIds: [],
            submissions: []
          }
        })
        const replacement = {
          sessionId: 'chat',
          page,
          fence: 7,
          ...(variant.claim ? { currentRequests: variant.claim } : {})
        }
        coalescer.push(
          type === 'snapshot'
            ? { type, ...replacement }
            : { type, reset: 'epoch_changed', ...replacement }
        )
        expect(dispatches).toBe(2)
        expect(state.items, `${type}/${variant.name}: new page wins`).toEqual([fresh])
        expect(state.items[0]).toBe(fresh)
        expect(state.epoch).toBe(page.epoch)
        expect(state.cursor).toBe(page.liveCursor)
        expect(state.fence).toBe(7)
        expect(state.submissions).toBe(page.submissions)
        expect(state.retainedOwnItemLimit).toBe(MAX_RETAINED_OWN_ITEMS)
        expect(state.retainedItemCap).toBe(MAX_RETAINED_ITEMS)
        expect(state.subagentRoster?.size).toBe(0)
        expect(state.subagentRoster).not.toBe(previous.subagentRoster)
        expect(state.hasOlder).toBe(false)
        expect(state.status).toBe('ready')
        expect(state.error).toBeUndefined()
        expect(state.readRefusal).toBeUndefined()
        expect(state.working).toBeUndefined()
        expect(state.latestTurn).toBeUndefined()
        expect(state.actionablePromptIds).toBeUndefined()
        expect(state.backgroundTasks).toBeUndefined()
        expect(state.activity).toBeNull()
        expect(state.unloadedTurnRevisions).toBeUndefined()
        if (variant.name === 'initial-legacy' || variant.name === 'different-resource') {
          expect(state.asyncQuestions).toBeUndefined()
          expect(state.requestContext).toBeUndefined()
          expect(state.requestAuthority).toBeUndefined()
          expect(state.asyncQuestionAuthority).toBeUndefined()
        } else {
          expect(state.asyncQuestions).toBe(records)
          expect(state.currentRequests).toBe(previous.currentRequests)
          expect(state.requestContext).toBe(context)
          expect(state.requestMarker).toBe(variant.name === 'new' ? variant.claim : marker)
          expect(state.requestAuthority).toBe(
            variant.name === 'established-markerless' ? undefined : marker
          )
          expect(state.asyncQuestionAuthority).toBe(
            variant.name === 'established-markerless' ? undefined : marker
          )
          expect(hasCompleteBlockingRequests(state)).toBe(
            variant.name !== 'new' && variant.name !== 'established-markerless'
          )
        }
        const nextOutput = output('new-live-output', 102)
        const batch: AgentSessionSubscribeEvent = {
          type: 'batch',
          sessionId: 'chat',
          currentRequests: state.requestMarker,
          batch: {
            cursor: { epoch: page.epoch, sequence: 102 },
            items: [nextOutput],
            removedItemIds: [],
            submissions: []
          },
          commands: [],
          queuedMessages: [],
          queuePause: null,
          nextQueuedMessageId: null,
          working: false,
          actionablePromptIds: [],
          latestTurn: null,
          backgroundTasks: null,
          activity: { turnId: 'fresh-turn', text: 'new live activity' }
        }
        coalescer.push(batch)
        expect(state.items).toEqual([fresh, nextOutput])
        expect(state.cursor).toBe(batch.batch.cursor)
        expect(state.commands).toBe(batch.commands)
        expect(state.queuedMessages).toBe(batch.queuedMessages)
        expect(state.working).toBe(false)
        expect(state.backgroundTasks).toBeNull()
        expect(state.activity).toBe(batch.activity)
        const changed = state
        coalescer.push({ ...batch, batch: { ...batch.batch, items: [] } })
        expect(state).toBe(changed)
        // A markerless context-fence change must explicitly clear old authority and data.
        coalescer.push({
          type: 'batch',
          sessionId: 'chat',
          fence: 8,
          batch: { cursor: batch.batch.cursor, items: [], removedItemIds: [], submissions: [] }
        })
        coalescer.flush()
        expect(state.requestAuthority).toBeUndefined()
        expect(state.asyncQuestionAuthority).toBeUndefined()
        expect(state.requestContext).toBeUndefined()
        expect(state.asyncQuestions).toBeUndefined()
        const history = {
          ...page,
          items: [output('explicit-history-page', 200)],
          liveCursor: { epoch: page.epoch, sequence: 200 },
          fence: 9
        }
        state = reduceStructuredAgentSession(state, { type: 'history-page', page: history })
        expect(state.items).toEqual(history.items)
        expect(state.cursor).toBe(history.liveCursor)
        expect(state.queuedMessages).toBe(batch.queuedMessages)
        const beforeOlder = state
        expect(
          reduceStructuredAgentSession(state, {
            type: 'older-page',
            requestedCursor: { epoch: 'wrong', sequence: 200 },
            page
          })
        ).toBe(beforeOlder)
        expect(
          reduceStructuredAgentSession(state, {
            type: 'older-page',
            requestedCursor: { epoch: page.epoch, sequence: 1 },
            page
          })
        ).toBe(beforeOlder)
        state = reduceStructuredAgentSession(state, {
          type: 'older-page',
          requestedCursor: { epoch: page.epoch, sequence: 200 },
          page
        })
        expect(state.items.map((item) => item.itemId)).toEqual([
          fresh.itemId,
          'explicit-history-page'
        ])
        expect(state.cursor).toBe(history.liveCursor)
        expect(reduceStructuredAgentSession(state, { type: 'event', event: { type: 'end' } })).toBe(
          state
        )
      } finally {
        coalescer.dispose()
      }
    }
  }
})

it('keeps standalone no-ops and tagged terminal bindings quiet while actual request changes publish', async () => {
  const { createNativeChatCurrentRequestsBinding } =
    await import('./native-chat-current-requests-binding')
  const payload = {
    blocking: [],
    asyncQuestions: null,
    context: { sessionId: 'chat', boundary: 'root' }
  }
  const installed = reduceStructuredAgentSession(
    reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'requests-marker',
      marker
    }),
    { type: 'requests-complete', marker, items: [], payload }
  )
  const unsupported = Object.defineProperty({ ...marker }, 'contract', { value: 'future.contract' })
  for (const claim of [marker, { ...marker, revision: 0, version: 'older' }, unsupported]) {
    expect
      .soft(reduceStructuredAgentSession(installed, { type: 'requests-marker', marker: claim }))
      .toBe(installed)
  }
  for (const claim of [marker, { ...marker, version: 'stale' }]) {
    expect
      .soft(
        reduceStructuredAgentSession(installed, {
          type: 'requests-complete',
          marker: claim,
          items: [],
          payload
        })
      )
      .toBe(installed)
  }
  const completePayload = { ...payload, asyncQuestions: [] }
  const complete = reduceStructuredAgentSession(installed, {
    type: 'requests-complete',
    marker,
    items: [],
    payload: completePayload
  })
  expect
    .soft(
      reduceStructuredAgentSession(complete, {
        type: 'requests-complete',
        marker,
        items: [],
        payload: completePayload
      })
    )
    .toBe(complete)
  for (const tag of ['source', 'identity'] as const) {
    const initialState = { ...installed, [tag]: 'host-a\0chat' }
    const publish = vi.fn()
    const read = vi.fn(async () => ({ marker, json: JSON.stringify(payload), nextCursor: null }))
    const binding = createNativeChatCurrentRequestsBinding({ initialState, publish, read })
    try {
      binding.observe({ type: 'appended', currentRequests: marker })
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      // Wait for actual read completion before checking publication, not just wrapper start.
      await read.mock.results[0].value
      await Promise.resolve()
      for (let i = 0; i < 50; i++) {
        binding.observe({ type: 'appended', currentRequests: marker })
        binding.observe({ type: 'appended', currentRequests: unsupported })
        binding.observe({
          type: 'appended',
          currentRequests: { ...marker, revision: 0, version: 'older' }
        })
      }
      expect.soft(publish).not.toHaveBeenCalled()
      expect(initialState[tag]).toBe('host-a\0chat')
      const beforeChange = publish.mock.calls.length
      const next = { ...marker, revision: 2, version: 'actual-change' }
      read.mockImplementation(async () => ({
        marker: next,
        json: JSON.stringify({ ...payload, asyncQuestions: [] }),
        nextCursor: null
      }))
      binding.observe({ type: 'appended', currentRequests: next })
      await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(beforeChange + 2))
      expect(publish.mock.calls.at(-1)?.[0].requestAuthority).toBe(next)
    } finally {
      binding.invalidate()
    }
  }
})
