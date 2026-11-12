import { acceptedAgentStatuses, type AcceptedAgentStatuses } from './accepted-agent-statuses'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
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

function statusEntries(entries: AgentStatusEntry[]): AcceptedAgentStatuses {
  return acceptedAgentStatuses(entries.map((entry, index) => [`${entry.paneKey}#${index}`, entry]))
}

function setup(entries: AgentStatusEntry[]) {
  const bumpEpochs = vi.fn()
  const scheduler = createFreshnessScheduler({
    getStatusEntries: () => statusEntries(entries),
    bumpEpochs
  })
  return { bumpEpochs, scheduler }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

describe('freshness scheduler completion deadlines', () => {
  afterEach(() => {
    vi.useRealTimers()
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

  it('keeps a deferred request queued while a scan is running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    let scheduler!: ReturnType<typeof createFreshnessScheduler>
    let firstRead = true
    const getStatusEntries = vi.fn((): AcceptedAgentStatuses => {
      if (firstRead) {
        firstRead = false
        scheduler.scheduleDeferred()
      }
      return acceptedAgentStatuses()
    })
    scheduler = createFreshnessScheduler({ getStatusEntries, bumpEpochs: vi.fn() })

    scheduler.scheduleDeferred()
    await flushMicrotasks()

    expect(getStatusEntries).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })
})
