import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

const NOW = new Date('2026-04-09T12:00:00.000Z').getTime()

function doneEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'done',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function setup(entries: AgentStatusEntry[]) {
  const bumpEpochs = vi.fn()
  const scheduler = createFreshnessScheduler({ getEntries: () => entries, bumpEpochs })
  return { bumpEpochs, scheduler }
}

describe('freshness scheduler completion deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes at the completion deadline even while the hook row stays fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    // Completion is 25m old; same-state `done` writes have kept updatedAt at now.
    const completedAt = NOW - 25 * 60_000
    const { bumpEpochs, scheduler } = setup([
      doneEntry({ stateStartedAt: completedAt, updatedAt: NOW })
    ])

    scheduler.schedule()
    vi.advanceTimersByTime(completedAt + AGENT_STATUS_STALE_AFTER_MS - NOW)
    expect(bumpEpochs).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(bumpEpochs).toHaveBeenCalledTimes(1)

    scheduler.dispose()
  })

  it('keeps the strict-expiry wake armed when rescheduled exactly at the boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { bumpEpochs, scheduler } = setup([
      doneEntry({
        stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS,
        updatedAt: NOW
      })
    ])

    scheduler.schedule()
    vi.advanceTimersByTime(1)
    expect(bumpEpochs).toHaveBeenCalledTimes(1)

    scheduler.dispose()
  })

  it('does not lose a completion deadline when an overdue timer is rescheduled after sleep', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const completedAt = NOW - 25 * 60_000
    const entries = [doneEntry({ stateStartedAt: completedAt, updatedAt: NOW })]
    const { bumpEpochs, scheduler } = setup(entries)

    scheduler.schedule()
    vi.setSystemTime(completedAt + AGENT_STATUS_STALE_AFTER_MS + 1)
    entries[0] = doneEntry({ stateStartedAt: completedAt, updatedAt: Date.now() })
    scheduler.schedule()

    expect(bumpEpochs).toHaveBeenCalledTimes(1)
    scheduler.schedule()
    expect(bumpEpochs).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('does not rearm an expired completion deadline in a zero-delay loop', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const completedAt = NOW - 25 * 60_000
    const { bumpEpochs, scheduler } = setup([
      doneEntry({ stateStartedAt: completedAt, updatedAt: NOW })
    ])

    scheduler.schedule()
    // Past both the completion deadline and the hook-freshness deadline.
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 60_000)

    // One bump for the completion boundary, one for hook freshness — never a spin.
    expect(bumpEpochs).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)

    scheduler.dispose()
  })

  it('ignores completions that cannot demand attention', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const completedAt = NOW - 25 * 60_000
    const { bumpEpochs, scheduler } = setup([
      doneEntry({ stateStartedAt: completedAt, updatedAt: NOW, interrupted: true })
    ])

    scheduler.schedule()
    vi.advanceTimersByTime(completedAt + AGENT_STATUS_STALE_AFTER_MS - NOW + 1)
    expect(bumpEpochs).not.toHaveBeenCalled()

    // Only the hook-freshness deadline remains.
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS)
    expect(bumpEpochs).toHaveBeenCalledTimes(1)

    scheduler.dispose()
  })

  it('still arms hook freshness for a working entry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { bumpEpochs, scheduler } = setup([
      doneEntry({ state: 'working', stateStartedAt: NOW, updatedAt: NOW })
    ])

    scheduler.schedule()
    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(bumpEpochs).toHaveBeenCalledTimes(1)

    scheduler.dispose()
  })
})
