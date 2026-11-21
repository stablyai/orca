import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'

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
  it("holds a hidden viewer's streaming text, then draws the newest of it once it shows", () => {
    vi.useFakeTimers()
    const events: AgentSessionSubscribeEvent[] = []
    let hidden = true
    let shown = (): void => {}
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event), {
      ms: 50,
      visibility: {
        hidden: () => hidden,
        subscribeShown: (onShown) => {
          shown = onShown
          return () => {}
        }
      }
    })
    const reply = (sequence: number, text: string) => ({
      ...batch(sequence),
      batch: {
        ...batch(sequence).batch,
        items: [
          {
            itemId: 'reply',
            revision: 1,
            sequence: 1,
            observedAt: 1,
            body: {
              kind: 'message' as const,
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, text }]
            }
          }
        ]
      }
    })
    for (let window = 1; window <= 20; window++) {
      coalescer.push(reply(window, 'word '.repeat(window)))
      vi.advanceTimersByTime(60)
    }
    expect(events).toEqual([])
    hidden = false
    shown()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      batch: {
        cursor: { sequence: 20 },
        items: [{ body: { blocks: [{ text: 'word '.repeat(20) }] } }]
      }
    })
    coalescer.dispose()
    vi.useRealTimers()
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

  it('keeps the newest prompt suggestion, a clear included, across merged batches', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    coalescer.push({ ...batch(1), promptSuggestion: { id: 's-1', text: 'add a test' } })
    coalescer.push(batch(2))
    coalescer.flush()
    coalescer.push({ ...batch(3), promptSuggestion: { id: 's-2', text: 'run it' } })
    coalescer.push({ ...batch(4), promptSuggestion: null })
    coalescer.flush()

    expect(events.map((event) => event.type === 'batch' && event.promptSuggestion)).toEqual([
      { id: 's-1', text: 'add a test' },
      null
    ])
  })

  it('reports held text drawn only when a show had text waiting', () => {
    vi.useFakeTimers()
    let hidden = true
    let shown = (): void => {}
    let drawn = 0
    const coalescer = createStructuredAgentSessionEventCoalescer(() => {}, {
      ms: 50,
      visibility: {
        hidden: () => hidden,
        heldDrawn: () => {
          drawn += 1
        },
        subscribeShown: (onShown) => {
          shown = onShown
          return () => {}
        }
      }
    })
    hidden = false
    shown()
    expect(drawn).toBe(0)
    hidden = true
    coalescer.push(batch(1))
    vi.advanceTimersByTime(100)
    hidden = false
    shown()
    expect(drawn).toBe(1)
    coalescer.dispose()
    vi.useRealTimers()
  })
})
