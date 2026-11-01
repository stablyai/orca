/** Silence with a live PTY is unverifiable, never proof of completion or current work; no-PTY rows may idle. */
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

import { makeTab } from '../../store/slices/store-session-test-harness'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

import { getCompactAgentSecondary } from './worktree-card-compact-agent-row'

const NOW = new Date('2026-05-04T12:00:00.000Z').getTime()
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const SILENT_FOR_MS = 34 * 60 * 1000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const observedAt = NOW - SILENT_FOR_MS
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'run the long build',
    updatedAt: observedAt,
    stateStartedAt: observedAt,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

const LIVE = { [TAB_ID]: ['pty-1'] }

describe('a stale entry on a pane Orca still holds', () => {
  it('measures the gap from the observation clock, not the delivery clock', () => {
    // A relay replay restamps `updatedAt`; the reading must not reset with it.
    const replayed = entry({ updatedAt: NOW, evidenceObservedAt: NOW - SILENT_FOR_MS })
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: TAB_ID, worktreeId: 'wt-1' })],
      entries: [replayed],
      retained: [],
      ptyIdsByTabId: LIVE,
      now: NOW
    })
    expect(rows[0].state).toBe('unverifiable')
    expect(getCompactAgentSecondary(rows[0], NOW)).toBe('No update in 34m')
  })
})
