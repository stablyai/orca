import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { createFreshnessDeadlines } from './worktree-card-slot-pane-index'

function entry(
  paneKey: string,
  evidenceAt: number,
  extra?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: evidenceAt,
    evidenceObservedAt: evidenceAt,
    stateStartedAt: evidenceAt,
    stateHistory: [],
    paneKey,
    ...extra
  }
}

describe('freshness deadlines', () => {
  it('visits only entries whose freshness flipped, in deadline order', () => {
    const deadlines = createFreshnessDeadlines()
    const live = Array.from({ length: 1000 }, (_, i) => entry(`p${i}`, i * 1000))
    live.forEach((tracked) => deadlines.set(tracked.paneKey, tracked, 0))

    const visited: string[] = []
    deadlines.expire(AGENT_STATUS_STALE_AFTER_MS + 2500, (paneKey) => visited.push(paneKey))
    expect(visited).toEqual(['p0', 'p1', 'p2'])

    visited.length = 0
    deadlines.expire(AGENT_STATUS_STALE_AFTER_MS + 2500, (paneKey) => visited.push(paneKey))
    expect(visited).toEqual([])
  })

  it('skips superseded and removed entries, and ignores ones already stale', () => {
    const deadlines = createFreshnessDeadlines()
    deadlines.set('a', entry('a', 0), 0)
    deadlines.set('b', entry('b', 0), 0)
    // Fresh evidence moves a's deadline; b goes away; c arrives already stale.
    deadlines.set('a', entry('a', 10_000), 10_000)
    deadlines.set('b', undefined, 10_000)
    deadlines.set('c', entry('c', 0), AGENT_STATUS_STALE_AFTER_MS + 1)

    const visited: string[] = []
    deadlines.expire(AGENT_STATUS_STALE_AFTER_MS + 1, (paneKey) => visited.push(paneKey))
    expect(visited).toEqual([])
    deadlines.expire(AGENT_STATUS_STALE_AFTER_MS + 10_001, (paneKey) => visited.push(paneKey))
    expect(visited).toEqual(['a'])
  })
})
