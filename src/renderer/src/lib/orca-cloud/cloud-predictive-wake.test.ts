import { describe, expect, it } from 'vitest'
import {
  HOVER_DWELL_MS,
  MAX_PREDICTIVE_AWAKE,
  REFUSAL_BACKOFF_MS,
  SELECT_DEBOUNCE_MS,
  SLEEP_COOLDOWN_MS,
  UNOPENED_HOLD_MS,
  WEAK_TRIGGER_MIN_GAP_MS,
  createPredictiveWakeController
} from './cloud-predictive-wake'

function harness(
  overrides: {
    enabled?: boolean
    candidates?: Set<string>
    refuse?: boolean
    /** Main found nothing to resume (the VM was already up). */
    alreadyUp?: boolean
    preflight?: (id: string) => Promise<boolean>
  } = {}
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
    ...(overrides.preflight ? { preflight: overrides.preflight } : {}),
    wake: (id) => {
      woken.push(id)
      return new Promise<boolean | 'skipped'>((resolve) => {
        settle[id] = () => resolve(overrides.alreadyUp ? 'skipped' : !overrides.refuse)
      })
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

  it('caps sandboxes woken on intent and not opened; the hold ends after the window or an open', async () => {
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
    // Opening one releases its slot at once; the other holds its slot until main's short idle
    // window has had its chance (main, not the window, puts it back to sleep).
    h.controller.claim('ws-a')
    expect(h.controller.awakeUnopened().size).toBe(1)
    await h.advance(UNOPENED_HOLD_MS)
    expect(h.controller.awakeUnopened().size).toBe(0)
    expect(h.slept).toEqual([])
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

  it('a drag cancels a pending hover wake and arms nothing until it ends', async () => {
    const h = harness()
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS - 100)
    h.controller.dragStart()
    await h.advance(HOVER_DWELL_MS)
    h.controller.hoverStart('ws-b')
    h.controller.select('ws-c')
    await h.advance(HOVER_DWELL_MS + SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual([])
    h.controller.dragEnd()
    h.controller.hoverStart('ws-b')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-b'])
  })

  it('a server preflight that says no skips the wake quietly, with no backoff and no held slot', async () => {
    let allow = false
    const checked: string[] = []
    const h = harness({
      preflight: async (id) => {
        checked.push(id)
        return allow
      }
    })
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(checked).toEqual(['ws-a'])
    expect(h.woken).toEqual([])
    expect(h.controller.inFlight().size).toBe(0)
    expect(h.controller.awakeUnopened().size).toBe(0)
    // Not a refusal: the next intent asks the server again rather than waiting out a backoff.
    allow = true
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual(['ws-a'])
  })

  it('a preflight that throws counts as no', async () => {
    const h = harness({ preflight: () => Promise.reject(new Error('offline')) })
    h.controller.select('ws-a')
    await h.advance(SELECT_DEBOUNCE_MS)
    expect(h.woken).toEqual([])
  })

  it('a hover the server preflight skips gives the hover gap back, so the next hover asks again', async () => {
    let allow = false
    const h = harness({ preflight: async () => allow })
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    h.controller.hoverEnd('ws-a')
    expect(h.woken).toEqual([])
    // The hold ended a moment later: well inside the 30 s gap, the next hover still wakes.
    allow = true
    await h.advance(1_000)
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-a'])
    expect(WEAK_TRIGGER_MIN_GAP_MS).toBeGreaterThan(1_000 + HOVER_DWELL_MS)
  })

  it('a wake that found the VM already up counts as no wake: no hold, no backoff, gap given back', async () => {
    const h = harness({ alreadyUp: true })
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    await h.settleAll('ws-a')
    expect(h.controller.awakeUnopened().size).toBe(0)
    expect(h.controller.inFlight().size).toBe(0)
    h.controller.hoverEnd('ws-a')
    await h.advance(1_000)
    h.controller.hoverStart('ws-a')
    await h.advance(HOVER_DWELL_MS)
    expect(h.woken).toEqual(['ws-a', 'ws-a'])
  })
})
