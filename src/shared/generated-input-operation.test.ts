import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runGeneratedInputOperation, type GeneratedInputSource } from './generated-input-operation'
import { GeneratedInputLifetime } from './generated-input-lifetime'
import { GeneratedInputObservation } from './generated-input-observation'

// A queue and terminal standing in for either source: one turn at a time, a ready composer.
function harness() {
  const writes: string[] = []
  let tail = Promise.resolve()
  const releases = { granted: 0, released: 0 }
  const observers = new Set<(data: string) => void>()
  let observeGate: Promise<void> | null = null
  const acquire = (signal: AbortSignal): Promise<() => void> => {
    const previous = tail
    let done!: () => void
    const turn = new Promise<void>((resolve) => {
      done = resolve
    })
    tail = previous.then(() => turn)
    return new Promise((resolve, reject) => {
      const giveUp = (): void => {
        done()
        reject(new Error('request_aborted'))
      }
      if (signal.aborted) {
        return giveUp()
      }
      signal.addEventListener('abort', giveUp, { once: true })
      void previous.then(() => {
        if (signal.aborted) {
          return
        }
        signal.removeEventListener('abort', giveUp)
        releases.granted += 1
        let once = false
        resolve(() => {
          if (!once) {
            once = true
            releases.released += 1
            done()
          }
        })
      })
    })
  }
  const source = (text: string): GeneratedInputSource => ({
    observe: async (onData) => {
      await observeGate
      observers.add(onData)
      return () => observers.delete(onData)
    },
    acquire,
    read: async () => ({
      screen: { lines: ['❯ '], alternateScreen: false },
      process: { known: false },
      bracketedPaste: true
    }),
    enterReserveMs: 0,
    writeText: async (gate) => {
      if (!(await gate.admit())) {
        return false
      }
      const taken = gate.dispatching()
      writes.push(text)
      taken(true)
      return true
    },
    settle: async () => {},
    writeEnter: async (gate) => {
      if (!(await gate.admit(text))) {
        return false
      }
      const taken = gate.dispatching()
      writes.push('\r')
      taken(true)
      return true
    }
  })
  const send = (text: string, budgetMs: number, signal?: AbortSignal) =>
    runGeneratedInputOperation(source(text), {
      agent: 'claude',
      submit: true,
      intent: 'running',
      lifetime: new GeneratedInputLifetime({
        deadline: Date.now() + budgetMs,
        signal,
        submit: true
      })
    })
  return {
    writes,
    releases,
    observers,
    send,
    /** Another writer holding the terminal's queue. */
    holdQueue: () => acquire(new AbortController().signal),
    holdObservation: (gate: Promise<void> | null) => {
      observeGate = gate
    }
  }
}

describe('one owner for a generated request lifetime and its queue turn', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // J6: the turn was granted while observation setup hung past the deadline.
  it('releases a turn granted during a stalled setup once, and the next send succeeds', async () => {
    const h = harness()
    let open!: () => void
    h.holdObservation(new Promise<void>((resolve) => (open = resolve)))
    const first = h.send('first', 50)
    await vi.advanceTimersByTimeAsync(51)
    await expect(first).resolves.toMatchObject({ outcome: 'not-sent' })
    open()
    h.holdObservation(null)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.releases).toEqual({ granted: 1, released: 1 })
    const second = await h.send('second', 3_000)
    expect(second.outcome).toBe('delivered')
    await second.finished
    expect(h.writes).toEqual(['second', '\r'])
    expect(h.releases).toEqual({ granted: 2, released: 2 })
  })

  it.each(['before its turn', 'after its turn, mid-setup'])(
    'an abort %s settles on time, holds no turn, and the next send succeeds',
    async (when) => {
      const h = harness()
      const aborter = new AbortController()
      let open!: () => void
      if (when !== 'before its turn') {
        h.holdObservation(new Promise<void>((resolve) => (open = resolve)))
      }
      const blocker = when === 'before its turn' ? h.send('head', 3_000) : null
      const aborted = h.send('aborted', 3_000, aborter.signal)
      aborter.abort()
      await expect(aborted).resolves.toMatchObject({ outcome: 'not-sent' })
      open?.()
      h.holdObservation(null)
      await (
        await blocker
      )?.finished
      const next = await h.send('next', 3_000)
      expect(next.outcome).toBe('delivered')
      await next.finished
      expect(h.writes.filter((data) => data === 'aborted')).toEqual([])
      expect(h.releases.granted).toBe(h.releases.released)
    }
  )

  // J4: work and storage are linear in the queued population, and all of it is released.
  it.each([10, 100])(
    'installs one observer per queued send for %i sends and releases all',
    async (count) => {
      const h = harness()
      const releaseQueue = await h.holdQueue()
      const sends = Array.from({ length: count }, (_, index) => h.send(`p${index}`, 60_000))
      await vi.advanceTimersByTimeAsync(0)
      // One observer per accepted send, each fed every chunk once: linear in the population.
      expect(h.observers.size).toBe(count)
      const chunk = 'x'.repeat(4096)
      for (let index = 0; index < 4; index += 1) {
        for (const observe of h.observers) {
          observe(chunk)
        }
      }
      releaseQueue()
      const results = await Promise.all(sends)
      await Promise.all(results.map((result) => result.finished))
      expect(results.every((result) => result.outcome === 'delivered')).toBe(true)
      expect(h.observers.size).toBe(0)
      // Every queued send's turn plus the holder's, each released exactly once.
      expect(h.releases).toEqual({ granted: count + 1, released: count + 1 })
    }
  )
})

describe('streaming-safe observation', () => {
  it('keeps the tail bounded and decodes an escape sequence split across chunks', async () => {
    const observation = new GeneratedInputObservation('claude-composer-prompt', () => {})
    let emit!: (data: string) => void
    await observation.start({
      observe: (onData) => {
        emit = onData
        return () => {}
      }
    })
    // A cursor-forward gap cut between its prefix and its final byte still reads as a gap.
    emit('Enter\x1b[')
    emit('1Cto\x1b[1Cconfirm')
    expect(observation.tail).toBe('Enter to confirm')
    for (let index = 0; index < 20; index += 1) {
      emit('y'.repeat(1024))
    }
    expect(observation.tail.length).toBeLessThanOrEqual(8 * 1024)
    observation.close()
    emit('after close')
    expect(observation.tail.endsWith('after close')).toBe(false)
  })
})
