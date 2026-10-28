import { describe, expect, it } from 'vitest'
import { enqueuePlantUmlRender } from './plantuml-render-queue'

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Records which renders are running at the same moment. */
function tracker(): { active: number; maxActive: number; order: string[] } {
  return { active: 0, maxActive: 0, order: [] }
}

describe('enqueuePlantUmlRender', () => {
  it('runs renders one at a time, in order', async () => {
    const t = tracker()
    const gates = [deferred(), deferred(), deferred()]

    const task = (name: string, gate: Deferred) => async (): Promise<void> => {
      t.active += 1
      t.maxActive = Math.max(t.maxActive, t.active)
      t.order.push(name)
      await gate.promise
      t.active -= 1
    }

    enqueuePlantUmlRender(task('a', gates[0]))
    enqueuePlantUmlRender(task('b', gates[1]))
    enqueuePlantUmlRender(task('c', gates[2]))

    for (const g of gates) {
      g.resolve()
      await new Promise((r) => setTimeout(r, 0))
    }

    expect(t.order).toEqual(['a', 'b', 'c'])
    expect(t.maxActive).toBe(1)
  })

  it('does not start a later render early when an earlier one settles first', async () => {
    // Why this exact interleaving: it is the shape that broke the previous
    // implementation. `a` settles while `b` is still queued, then `c` arrives. If
    // the queue reset is unconditional, `c` chains off the stale resolved promise
    // and runs alongside `b`.
    const t = tracker()
    const bGate = deferred()

    const instant = (name: string) => async (): Promise<void> => {
      t.active += 1
      t.maxActive = Math.max(t.maxActive, t.active)
      t.order.push(name)
      t.active -= 1
    }
    const slow = (name: string, gate: Deferred) => async (): Promise<void> => {
      t.active += 1
      t.maxActive = Math.max(t.maxActive, t.active)
      t.order.push(name)
      await gate.promise
      t.active -= 1
    }

    enqueuePlantUmlRender(instant('a'))
    enqueuePlantUmlRender(slow('b', bGate))
    // Let `a` finish and its cleanup run while `b` is mid-flight.
    await new Promise((r) => setTimeout(r, 0))
    enqueuePlantUmlRender(instant('c'))
    await new Promise((r) => setTimeout(r, 0))

    expect(t.order).toEqual(['a', 'b'])
    expect(t.maxActive).toBe(1)

    bGate.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(t.order).toEqual(['a', 'b', 'c'])
    expect(t.maxActive).toBe(1)
  })

  it('keeps draining after a render rejects', async () => {
    const ran: string[] = []

    enqueuePlantUmlRender(async () => {
      ran.push('boom')
      throw new Error('render failed')
    })
    enqueuePlantUmlRender(async () => {
      ran.push('after')
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(ran).toEqual(['boom', 'after'])
  })
})
