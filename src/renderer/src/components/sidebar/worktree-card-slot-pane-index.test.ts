import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  agentStatusStaleAt,
  createFreshnessDeadlines,
  forEachPaneDisplayer,
  recordDisplayedPanes,
  resetSlotPaneIndexForTests
} from './worktree-card-slot-pane-index'

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

function displayers(paneKey: string): string[] {
  const out: string[] = []
  forEachPaneDisplayer(paneKey, (id) => out.push(id))
  return out.sort()
}

afterEach(() => {
  resetSlotPaneIndexForTests()
})

describe('displayed pane index', () => {
  it('replaces a workspace’s panes on each projection, per host', () => {
    const local = composeWorktreeHostIdentity('local', 'w1')
    const remote = composeWorktreeHostIdentity('runtime:box', 'w1')
    recordDisplayedPanes(local, ['a', 'b'])
    recordDisplayedPanes(remote, ['b'])
    expect(displayers('b')).toEqual(['w1', 'w1'])

    recordDisplayedPanes(local, ['c'])
    expect(displayers('a')).toEqual([])
    expect(displayers('b')).toEqual(['w1'])
    expect(displayers('c')).toEqual(['w1'])
  })
})

describe('freshness deadlines', () => {
  it('agrees with isAgentStatusFresh at the boundary', () => {
    const tracked = entry('p', 1000)
    const staleAt = agentStatusStaleAt(tracked)!
    expect(isAgentStatusFresh(tracked, staleAt, AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
    expect(isAgentStatusFresh(tracked, staleAt + 1, AGENT_STATUS_STALE_AFTER_MS)).toBe(false)
    expect(agentStatusStaleAt(entry('p', 1000, { structuredHostOwned: true }))).toBeNull()
    expect(agentStatusStaleAt(entry('p', 1000, { restoredUnconfirmed: true }))).toBeNull()
  })

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

  it('stays bounded when one pane is updated many times', () => {
    const deadlines = createFreshnessDeadlines()
    for (let i = 0; i < 10_000; i += 1) {
      deadlines.set('busy', entry('busy', i), i)
    }
    const visited: string[] = []
    deadlines.expire(Number.MAX_SAFE_INTEGER, (paneKey) => visited.push(paneKey))
    expect(visited).toEqual(['busy'])
  })
})
