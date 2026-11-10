import { describe, expect, it } from 'vitest'
import {
  HOVER_DWELL_MS,
  MAX_PREDICTIVE_AWAKE,
  REFUSAL_BACKOFF_MS,
  SELECT_DEBOUNCE_MS,
  SLEEP_COOLDOWN_MS,
  UNOPENED_SLEEP_MS,
  WEAK_TRIGGER_MIN_GAP_MS,
  createPredictiveWakeController
} from './cloud-predictive-wake'

function harness(
  overrides: { enabled?: boolean; candidates?: Set<string>; refuse?: boolean } = {}
) {
  let now = 1_000_000
  const timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 1
  const woken: string[] = []
  const slept: string[] = []
  const settle: Record<string, () => void> = {}
  const candidates = overrides.candidates ?? new Set(['ws-a', 'ws-b', 'ws-c', 'ws-d'])
  const controller = createPredictiveWakeController({
    now: () => now,
    isEnabled: () => overrides.enabled ?? true,
    isWakeCandidate: (id) => candidates.has(id),
    wake: (id) => {
      woken.push(id)
      return new Promise<boolean>((resolve) => {
        settle[id] = () => resolve(!overrides.refuse)
      })
    },
    sleep: async (id) => {
      slept.push(id)
    },
    setTimer: (run, ms) => {
      const id = nextId++
      timers.push({ at: now + ms, run, id })
      return () => {
        const index = timers.findIndex((t) => t.id === id)
        if (index !== -1) {
          timers.splice(index, 1)
        }
      }
    }
  })
  const flush = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve()
    }
  }
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1)
      timer.run()
    }
    await flush()
  }
  const settleAll = async (id: string) => {
    settle[id]!()
    await flush()
  }
  return { controller, woken, slept, advance, settleAll }
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
  })

  it('caps sandboxes woken on intent and not opened, and puts unopened ones back to sleep', async () => {
    const h = harness()
    for (const id of ['ws-a', 'ws-b', 'ws-c']) {
      h.controller.select(id)
      await h.advance(SELECT_DEBOUNCE_MS)
    }
    expect(h.woken).toEqual(['ws-a', 'ws-b'])
    await h.settleAll('ws-a')
    await h.settleAll('ws-b')
    // Both awake and unopened: still at the cap.
    expect(h.controller.awakeUnopened().size).toBe(MAX_PREDICTIVE_AWAKE)
    h.controller.select('ws-c')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a', 'ws-b'])
    // Opening one releases its slot and keeps it awake; the other goes back to sleep.
    h.controller.claim('ws-a')
    await h.advance(UNOPENED_SLEEP_MS)
    expect(h.slept).toEqual(['ws-b'])
    expect(h.controller.awakeUnopened().size).toBe(0)
  })

  it('a refusal (seat cap) is silent, frees the slot and backs off', async () => {
    const h = harness({ refuse: true })
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.controller.isSilent('ws-a')).toBe(true)
    await h.settleAll('ws-a')
    expect(h.controller.isSilent('ws-a')).toBe(false)
    expect(h.controller.inFlight().size).toBe(0)
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
    await h.advance(REFUSAL_BACKOFF_MS)
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a', 'ws-a'])
  })

  it('opening the workspace claims the wake so its progress and failures show', async () => {
    const h = harness()
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    h.controller.claim('ws-a')
    expect(h.controller.isSilent('ws-a')).toBe(false)
    await h.settleAll('ws-a')
    expect(h.controller.awakeUnopened().size).toBe(0)
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

  it('focus never undoes a sleep the user chose, until they act on that workspace', async () => {
    const h = harness()
    h.controller.windowBlur()
    h.controller.noteSlept('ws-a')
    await h.advance(SLEEP_COOLDOWN_MS + 1)
    h.controller.windowFocus('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual([])
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
  })

  it('hover and focus share one rate limit', async () => {
    const h = harness()
    h.controller.windowBlur()
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    h.controller.windowFocus('ws-b')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
    await h.advance(WEAK_TRIGGER_MIN_GAP_MS)
    h.controller.windowFocus('ws-b')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a', 'ws-b'])
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

  it('does nothing when the setting is off', async () => {
    const h = harness({ enabled: false })
    h.controller.hoverStart('ws-a')
    h.controller.select('ws-b')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual([])
  })
})
