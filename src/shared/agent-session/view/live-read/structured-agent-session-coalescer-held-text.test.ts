import { expect, it, vi } from 'vitest'
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

it("draws a shown viewer's held text together with the host's newest text, at once", () => {
  vi.useFakeTimers()
  const events: AgentSessionSubscribeEvent[] = []
  let hidden = true
  let shown = (): void => {}
  let drawn = 0
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event), {
    ms: 50,
    visibility: {
      hidden: () => hidden,
      heldDrawn: () => {
        drawn += 1
      },
      sendsShownTail: () => true,
      subscribeShown: (onShown) => {
        shown = onShown
        return () => {}
      }
    }
  })
  coalescer.push(batch(1))
  vi.advanceTimersByTime(100)
  hidden = false
  shown()
  // The save held while hidden waits for the newest text rather than drawing first.
  expect(events).toEqual([])
  vi.advanceTimersByTime(10)
  coalescer.push(batch(2))
  expect(events.map((event) => event.type === 'batch' && event.batch.cursor.sequence)).toEqual([2])
  expect(drawn).toBe(1)

  // With no newest text coming in time, what was held draws alone.
  hidden = true
  coalescer.push(batch(3))
  vi.advanceTimersByTime(100)
  hidden = false
  shown()
  vi.advanceTimersByTime(299)
  expect(events).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(events).toHaveLength(2)
  expect(drawn).toBe(2)
  coalescer.dispose()
  vi.useRealTimers()
})

it('keeps a saved revision when a live snapshot read before the save arrives after it', () => {
  vi.useFakeTimers()
  const events: AgentSessionSubscribeEvent[] = []
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event), {
    ms: 50
  })
  const reply = (sequence: number, revision: number, text: string) => ({
    ...batch(sequence),
    batch: {
      ...batch(sequence).batch,
      items: [
        {
          itemId: 'reply',
          revision,
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
  coalescer.push(reply(2, 2, 'The whole reply, saved'))
  coalescer.push(reply(2, 1, 'The whole'))
  vi.advanceTimersByTime(50)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    batch: { items: [{ revision: 2, body: { blocks: [{ text: 'The whole reply, saved' }] } }] }
  })
  vi.useRealTimers()
})
