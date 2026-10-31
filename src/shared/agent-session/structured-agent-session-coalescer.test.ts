import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../agent-session-journal-types'
import { projectNativeChatTranscriptMessages } from '../native-chat-transcript-projection'
import { projectStructuredAgentSessionMessages } from '../structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../structured-agent-session-reducer'
import type { AgentSessionSubscribeEvent } from '../agent-session-wire'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS,
  createStructuredAgentSessionEventCoalescer
} from './structured-agent-session-coalescer'

function batch(
  sequence: number,
  backgroundTasks?: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>['backgroundTasks'],
  activity?: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>['activity']
): Extract<AgentSessionSubscribeEvent, { type: 'batch' }> {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: {
      cursor: { epoch: 'epoch-1', sequence },
      items: [],
      removedItemIds: [],
      submissions: []
    },
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    ...(activity !== undefined ? { activity } : {})
  }
}

describe('structured agent session event coalescer', () => {
  it('preserves background task state when a journal batch follows it', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(
      batch(1, {
        state: 'monitoring',
        tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
      })
    )
    coalescer.push(batch(2))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      backgroundTasks: {
        state: 'monitoring',
        tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
      }
    })
  })

  it('keeps an explicit terminal state as the newest coalesced value', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(batch(1, { state: 'monitoring' }))
    coalescer.push(batch(1, null))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ backgroundTasks: null })
  })

  it('keeps only the latest ephemeral activity value', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(batch(1, undefined, { turnId: 'turn-1', text: 'Thinking' }))
    coalescer.push(batch(1, undefined, { turnId: 'turn-1', text: 'Checking the result' }))
    coalescer.push(batch(1, undefined, null))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ activity: null })
  })

  it('delivers each queue list at once, in order, each with the pause it was published with', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const draft = {
      messageId: 'draft-1',
      position: 1,
      body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
      state: 'waiting' as const
    }

    coalescer.push({ ...batch(1), queuedMessages: [draft], queuePause: { reason: 'stopped' } })
    coalescer.push({ ...batch(2), queuedMessages: [], queuePause: null })
    coalescer.push(batch(3))
    coalescer.flush()

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      queuedMessages: [draft],
      queuePause: { reason: 'stopped' }
    })
    expect(events[1]).toMatchObject({ queuedMessages: [], queuePause: null })
    expect(events[2]).not.toHaveProperty('queuedMessages')
  })

  it('passes a queue list through at once, with anything it held merged ahead of it', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    coalescer.push(batch(1))
    coalescer.push({
      ...batch(2),
      queuedMessages: [
        {
          messageId: 'card-1',
          position: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued' }] },
          state: 'waiting'
        }
      ],
      queuePause: null
    })
    // Queue cards must bypass the coalescing delay.
    expect(events.map((event) => event.type === 'batch' && event.batch.cursor.sequence)).toEqual([
      1, 2
    ])
    expect(events[1]).toMatchObject({ queuedMessages: [{ messageId: 'card-1' }] })
    coalescer.dispose()
  })

  it("delivers the queue's next card with its list, ahead of a later token batch", () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    coalescer.push({ ...batch(1), queuedMessages: [], nextQueuedMessageId: 'draft-1' })
    const token = {
      itemId: 'assistant-1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'streaming' }]
      }
    }
    const tokens = batch(2)
    coalescer.push({ ...tokens, batch: { ...tokens.batch, items: [token] } })
    coalescer.flush()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ nextQueuedMessageId: 'draft-1' })
    expect(events[1]).not.toHaveProperty('queuedMessages')
  })

  it('keeps the latest turn a coalesced frame carried, and a null one as an answer', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const running = {
      itemId: 'turn-1',
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running' as const }
    }

    coalescer.push({ ...batch(1), latestTurn: running })
    coalescer.push(batch(2))
    coalescer.flush()
    coalescer.push({ ...batch(3), latestTurn: running })
    coalescer.push({ ...batch(4), latestTurn: null })
    coalescer.flush()

    expect(events.map((event) => (event.type === 'batch' ? event.latestTurn : 'other'))).toEqual([
      running,
      null
    ])
  })
  it('ends a catch-up only when the last page it merged did', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const page = (sequence: number, hasNewer: boolean) => ({
      ...batch(sequence),
      ...(hasNewer ? { hasNewer: true as const } : {})
    })

    coalescer.push(page(1, true))
    coalescer.push(page(2, true))
    coalescer.flush()
    coalescer.push(page(3, true))
    coalescer.push(page(4, false))
    coalescer.flush()

    expect(events.map((event) => event.type === 'batch' && event.hasNewer === true)).toEqual([
      true,
      false
    ])
  })

  it('drops it when a later frame carries rows without it, as applying both would', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const token = (sequence: number) => ({
      ...batch(sequence),
      batch: {
        ...batch(sequence).batch,
        items: [
          {
            itemId: `token-${sequence}`,
            revision: 1,
            sequence,
            observedAt: sequence,
            body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] }
          }
        ]
      }
    })
    const running = {
      itemId: 'turn-1',
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running' as const }
    }

    // Old-host rows without latestTurn must clear the prior claim.
    coalescer.push({ ...token(1), latestTurn: running })
    coalescer.push(token(2))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('latestTurn')
  })
})

describe('coalesced history removals', () => {
  const roster = {
    type: 'subagent-group' as const,
    groupId: 'group',
    agents: [{ id: 'helper', label: 'review', state: 'working' as const }]
  }
  const item = (withRoster = false): AgentJournalRenderItem => ({
    itemId: 'answer',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: withRoster ? [roster] : [{ type: 'text', text: 'answer' }]
    }
  })
  function history() {
    let state: StructuredAgentSessionState = { ...EMPTY_STRUCTURED_AGENT_SESSION, epoch: 'epoch-1' }
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
      events.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event }, 0)
    })
    const push = (
      sequence: number,
      items: AgentJournalRenderItem[],
      removedItemIds: string[] = []
    ) => {
      const event = {
        ...batch(sequence),
        batch: { ...batch(sequence).batch, items, removedItemIds }
      }
      coalescer.push(event)
      return event
    }
    return { coalescer, events, push, state: () => state }
  }

  it.each([
    { name: 'assistant text', withRoster: false, replace: false },
    { name: 'assistant roster', withRoster: true, replace: false },
    { name: 'same-frame replacement', withRoster: false, replace: true }
  ])(
    'preserves removal order for $name, then permits a later reintroduction',
    ({ withRoster, replace }) => {
      vi.useFakeTimers()
      const h = history()
      const visibleBlocks = () =>
        projectNativeChatTranscriptMessages(
          projectStructuredAgentSessionMessages(h.state().items, [], h.state().submissions)
        ).map((message) => message.blocks)
      try {
        const original = item(withRoster)
        h.push(1, [original])
        h.push(2, [{ ...original, revision: 2 }])
        expect(h.events).toHaveLength(0)
        const replacement: AgentJournalRenderItem = {
          ...item(),
          revision: 3,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'replacement' }]
          }
        }
        const removal = h.push(3, replace ? [replacement] : [], ['answer'])
        const immediateCursor = h.state().cursor
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        expect(h.state().items).toEqual(replace ? [replacement] : [])
        expect(immediateCursor).toEqual(removal.batch.cursor)
        expect(h.events).toHaveLength(2)
        expect(h.events[0]).toMatchObject({ batch: { items: [{ itemId: 'answer', revision: 2 }] } })
        expect(h.events[1]).toBe(removal)
        expect(h.state().items).toEqual(replace ? [replacement] : [])
        expect(h.state().subagentRoster?.size).toBe(0)
        expect(h.state().subagentRoster?.has('helper')).toBe(false)
        expect(h.state().cursor).toEqual(removal.batch.cursor)
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        expect(h.state().items).toEqual(replace ? [replacement] : [])
        expect(visibleBlocks()).toEqual(replace ? [[{ type: 'text', text: 'replacement' }]] : [])
        const reintroduced = { ...item(), revision: 4, sequence: 4 }
        h.push(4, [reintroduced])
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        expect(h.state().items).toEqual([reintroduced])
        expect(visibleBlocks()).toEqual([[{ type: 'text', text: 'answer' }]])
      } finally {
        h.coalescer.dispose()
        vi.useRealTimers()
      }
    }
  )

  it('removes a system roster immediately after flushing an unrelated assistant update', () => {
    const h = history()
    try {
      h.push(1, [
        { ...item(), itemId: 'roster', body: { kind: 'message', role: 'system', blocks: [roster] } }
      ])
      expect(h.state().subagentRoster?.has('helper')).toBe(true)
      const answer = { ...item(), sequence: 2 }
      h.push(2, [answer])
      const removal = h.push(3, [], ['roster'])
      expect(h.state().cursor).toEqual(removal.batch.cursor)
      expect(h.state().items).toEqual([answer])
      expect(h.state().subagentRoster?.size).toBe(0)
    } finally {
      h.coalescer.dispose()
    }
  })

  it('bounds destructive burst work at N and 10N while ordinary updates still aggregate', () => {
    const population = 1_000
    const retained = Array.from({ length: population }, (_, index) => ({
      ...item(),
      itemId: `retained-${index}`,
      sequence: index + 1
    }))
    function run(count: number, remove: boolean) {
      let state: StructuredAgentSessionState = {
        ...EMPTY_STRUCTURED_AGENT_SESSION,
        epoch: 'epoch-1',
        status: 'ready',
        items: retained,
        retainedOwnItemLimit: population + 1,
        retainedItemCap: population + 1
      }
      let reductions = 0
      let inputVisits = 0
      const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
        reductions++
        // Count retained input reads, including head lookup, without instrumenting production.
        const items = [...state.items]
        items.forEach((row, index) => {
          Object.defineProperty(items, index, {
            get() {
              inputVisits++
              return row
            }
          })
        })
        state = reduceStructuredAgentSession({ ...state, items }, { type: 'event', event }, 0)
      })
      try {
        for (let index = 0; index < count; index++) {
          const update = batch(population + index * 2 + 1)
          const row: AgentJournalRenderItem = {
            ...item(),
            itemId: remove ? `answer-${index}` : 'answer',
            sequence: remove ? update.batch.cursor.sequence : population + 1,
            revision: index + 1
          }
          coalescer.push({ ...update, batch: { ...update.batch, items: [row] } })
          if (remove) {
            const removal = batch(update.batch.cursor.sequence + 1)
            coalescer.push({
              ...removal,
              batch: { ...removal.batch, removedItemIds: [row.itemId] }
            })
          }
        }
        expect(reductions).toBe(remove ? 2 * count : 0)
        vi.advanceTimersByTime(STRUCTURED_AGENT_SESSION_CLIENT_COALESCE_MS)
        expect(reductions).toBe(remove ? 2 * count : 1)
        expect(inputVisits).toBeGreaterThan(0)
        expect(inputVisits).toBeLessThanOrEqual(reductions * (population + 2))
        expect(state.items.slice(0, population)).toEqual(retained)
        expect(state.items.slice(population)).toEqual(
          remove ? [] : [expect.objectContaining({ itemId: 'answer', revision: count })]
        )
        return { reductions, inputVisits }
      } finally {
        coalescer.dispose()
      }
    }
    vi.useFakeTimers()
    try {
      const small = run(10, true)
      const large = run(100, true)
      expect(large.reductions).toBe(10 * small.reductions)
      expect(large.inputVisits).toBeLessThanOrEqual(10 * small.inputVisits)
      run(10, false)
      run(100, false)
    } finally {
      vi.useRealTimers()
    }
  })
})
