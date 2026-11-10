import { describe, expect, it } from 'vitest'
import {
  HOVER_DWELL_MS,
  HOVER_MIN_GAP_MS,
  SELECT_DEBOUNCE_MS,
  SLEEP_COOLDOWN_MS,
  createPredictiveWakeController
} from './cloud-predictive-wake'

function harness(
  overrides: { enabled?: boolean; candidates?: Set<string>; wakeFails?: boolean } = {}
) {
  let now = 1_000_000
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 1
  const woken: string[] = []
  const settle: Record<string, () => void> = {}
  const candidates = overrides.candidates ?? new Set(['ws-a', 'ws-b', 'ws-c'])
  const controller = createPredictiveWakeController({
    now: () => now,
    isEnabled: () => overrides.enabled ?? true,
    isWakeCandidate: (id) => candidates.has(id),
    wake: (id) => {
      woken.push(id)
      return new Promise<void>((resolve, reject) => {
        settle[id] = () =>
          overrides.wakeFails ? reject(new Error('concurrency_limit')) : resolve()
      })
    },
    setTimer: (run, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, run, id })
      return id
    },
    clearTimer: (id) => {
      const index = timers.findIndex((t) => t.id === id)
      if (index !== -1) {
        timers.splice(index, 1)
      }
    }
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.run()
    }
    await Promise.resolve()
    await Promise.resolve()
  }
  return { controller, woken, settle, advance, candidates }
}

describe('predictive wake', () => {
  it('wakes after a hover dwell, not on a pass-over', async () => {
    const h = harness()
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS - 50)
    h.controller.hoverEnd('ws-a')
    await h.advance(100)
    expect(h.woken).toEqual([])
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-a'])
  })

  it('debounces selection and is single-flight per workspace', async () => {
    const h = harness()
    h.controller.select('ws-a')
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
    h.settle['ws-a']!()
    await h.advance(0)
    expect(h.controller.inFlight().size).toBe(0)
  })

  it('a refused wake (seat cap) is silent and frees the slot', async () => {
    const h = harness({ wakeFails: true })
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.controller.isSilent('ws-a')).toBe(true)
    h.settle['ws-a']!()
    await h.advance(0)
    expect(h.controller.isSilent('ws-a')).toBe(false)
    expect(h.controller.inFlight().size).toBe(0)
  })

  it('opening the workspace claims the wake so its progress and failures show', async () => {
    const h = harness()
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    h.controller.claim('ws-a')
    expect(h.controller.isSilent('ws-a')).toBe(false)
  })

  it('never wakes on app launch: the first window focus is ignored', async () => {
    const h = harness()
    h.controller.windowFocus('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual([])
    h.controller.windowBlur()
    h.controller.windowFocus('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
  })

  it('does not wake what was just slept, or what is not a candidate (archived, awake)', async () => {
    const h = harness({ candidates: new Set(['ws-a']) })
    h.controller.noteSlept('ws-a')
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    h.controller.select('ws-archived')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual([])
    await h.advance(SLEEP_COOLDOWN_MS)
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
  })

  it('rate-limits hover wakes and caps concurrent predictive wakes', async () => {
    const h = harness()
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    h.controller.hoverStart('ws-b')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-a'])
    h.controller.select('ws-b')
    await h.advance(SELECT_DEBOUNCE_MS)
    h.controller.select('ws-c')
    await h.advance(SELECT_DEBOUNCE_MS)
    // Two in flight: the third waits for a free slot.
    expect(h.woken).toEqual(['ws-a', 'ws-b'])
    await h.advance(HOVER_MIN_GAP_MS)
    h.settle['ws-a']!()
    await h.advance(0)
    h.controller.hoverStart('ws-c')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-a', 'ws-b', 'ws-c'])
  })

  it('does nothing when the setting is off', async () => {
    const h = harness({ enabled: false })
    h.controller.hoverStart('ws-a')
    h.controller.select('ws-b')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual([])
  })
})
