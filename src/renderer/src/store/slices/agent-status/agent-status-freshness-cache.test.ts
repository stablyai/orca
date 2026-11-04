import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import '../../../../../shared/agent-status/contracts/agent-status-freshness'
import {
  agentStatusFreshnessScanCounters,
  createFreshnessScheduler,
  resetAgentStatusFreshnessScanCounters
} from './agent-status-freshness-scheduler'

const NOW = new Date('2026-04-09T12:00:00.000Z').getTime()
const MINUTE = 60_000

type StatusMap = Record<string, AgentStatusEntry>

function entry(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

type Step = {
  advanceMs: number
  nextEntry?: AgentStatusEntry
  evictedPaneKeys?: string[]
}

/**
 * Insert / replace / evict sequence with a single unique minimum at every point, so a cache that
 * failed to notice the minimum leaving would arm a different instant than the rescan reference.
 */
function buildScript(): Step[] {
  const working = (paneKey: string, updatedAt: number): AgentStatusEntry =>
    entry(paneKey, { state: 'working', updatedAt, stateStartedAt: updatedAt })
  return [
    // Distinct hook expiries: A at +10m, B at +20m, C at +30m.
    { advanceMs: 0, nextEntry: working('tab:a', NOW - 20 * MINUTE) },
    { advanceMs: 0, nextEntry: working('tab:b', NOW - 10 * MINUTE) },
    { advanceMs: 0, nextEntry: working('tab:c', NOW) },
    // Replacing a non-minimum pane must not move the wake.
    { advanceMs: MINUTE, nextEntry: working('tab:c', NOW + MINUTE) },
    // A done row whose completion deadline already passed contributes only its hook expiry.
    {
      advanceMs: MINUTE,
      nextEntry: entry('tab:d', {
        stateStartedAt: NOW - 29 * MINUTE,
        updatedAt: NOW + 2 * MINUTE
      })
    },
    // Replacing the pane that HOLDS the minimum.
    { advanceMs: MINUTE, nextEntry: working('tab:a', NOW + 3 * MINUTE) },
    // Evicting the pane that now holds the minimum.
    {
      advanceMs: MINUTE,
      nextEntry: working('tab:f', NOW + 4 * MINUTE),
      evictedPaneKeys: ['tab:b']
    },
    // A completion deadline that lands before every hook expiry, then crosses it.
    {
      advanceMs: 0,
      nextEntry: entry('tab:g', {
        stateStartedAt: NOW - 25 * MINUTE,
        updatedAt: NOW + 4 * MINUTE
      })
    },
    { advanceMs: 2 * MINUTE },
    // A hydrated row whose hook expiry is EARLIER than the standing minimum.
    { advanceMs: 0, nextEntry: working('tab:i', NOW - 22 * MINUTE) },
    { advanceMs: 3 * MINUTE },
    // An interrupted row never contributes a completion deadline.
    {
      advanceMs: MINUTE,
      nextEntry: entry('tab:h', { interrupted: true, updatedAt: NOW + 7 * MINUTE })
    },
    { advanceMs: 25 * MINUTE },
    { advanceMs: 10 * MINUTE }
  ]
}

type PassResult = { armedAt: number[]; bumpedAt: number[] }

function runPass(mode: 'cached' | 'rescan', script: Step[]): PassResult {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  const armedAt: number[] = []
  const bumpedAt: number[] = []
  const nativeSetTimeout = globalThis.setTimeout
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    timeout?: number
  ) => {
    armedAt.push(Date.now() + (timeout ?? 0))
    return nativeSetTimeout(handler as () => void, timeout)
  }) as unknown as typeof globalThis.setTimeout)

  let current: StatusMap = {}
  const scheduler = createFreshnessScheduler({
    // The rescan reference hands back a fresh object every read, so the cache can never validate.
    getStatusEntries: () => (mode === 'cached' ? current : { ...current }),
    bumpEpochs: () => {
      bumpedAt.push(Date.now())
    }
  })

  for (const step of script) {
    if (step.advanceMs > 0) {
      vi.advanceTimersByTime(step.advanceMs)
    }
    if (step.nextEntry) {
      const previousEntries = current
      const nextEntries: StatusMap = {
        ...previousEntries,
        [step.nextEntry.paneKey]: step.nextEntry
      }
      const evictedEntries: AgentStatusEntry[] = []
      for (const paneKey of step.evictedPaneKeys ?? []) {
        const evicted = previousEntries[paneKey]
        if (evicted) {
          evictedEntries.push(evicted)
          delete nextEntries[paneKey]
        }
      }
      current = nextEntries
      if (mode === 'cached') {
        scheduler.noteLiveEntryDelta({
          previousEntries,
          nextEntries,
          nextEntry: step.nextEntry,
          replacedEntry: previousEntries[step.nextEntry.paneKey],
          evictedEntries
        })
      }
    }
    scheduler.schedule()
  }

  scheduler.dispose()
  setTimeoutSpy.mockRestore()
  vi.useRealTimers()
  return { armedAt, bumpedAt }
}

describe('freshness scheduler cached minimum', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms the same wake instants and crossings as a full rescan', () => {
    const script = buildScript()

    const rescan = runPass('rescan', script)
    const cached = runPass('cached', script)

    expect(cached.armedAt).toEqual(rescan.armedAt)
    expect(cached.bumpedAt).toEqual(rescan.bumpedAt)
    expect(cached.armedAt.length).toBeGreaterThan(0)
  })

  it('answers repeated commits from the cache instead of revisiting every entry', () => {
    resetAgentStatusFreshnessScanCounters()
    runPass('cached', buildScript())
    const cachedScans = agentStatusFreshnessScanCounters.cachedScans
    const cachedVisits = agentStatusFreshnessScanCounters.entryVisits

    resetAgentStatusFreshnessScanCounters()
    runPass('rescan', buildScript())

    expect(cachedScans).toBeGreaterThan(0)
    expect(cachedVisits).toBeLessThan(agentStatusFreshnessScanCounters.entryVisits)
  })
})
